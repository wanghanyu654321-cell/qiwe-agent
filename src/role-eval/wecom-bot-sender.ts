import type {BotReadScope} from './wecom-bot-context.js';
import type {BotReplyPlan} from './wecom-bot-transport.js';
export interface BotSdkPort {
 mode:'isolated-synthetic';
 /** Authenticated and connected lifecycle, not merely WebSocket.OPEN. */
 ready():boolean;
 reply(frame:{headers:{req_id:string}},body:BotReplyPlan['body']):Promise<unknown>;
 sendMessage(chatid:string,body:{msgtype:'markdown';markdown:{content:string}}):Promise<unknown>;
}
export interface BotSendOutcome {state:'blocked'|'accepted'|'rejected'|'unknown';apiErrorCode:number|null;msgid:null;detail:string;ackReqId?:string;}
export interface BotFileSdkPort {
 mode:'isolated-synthetic';
 uploadMedia(bytes:Buffer,options:{type:'file';filename:string}):Promise<unknown>;
 /** Explicit single-chat extension documented by the current official protocol. */
 sendMessage(member:string,body:{msgtype:'file';chat_type:1;file:{media_id:string}}):Promise<unknown>;
}
/** Adapted from the existing application sender's bounded/preflight/result policy.
 * No HTTP credential flow or implicit network fallback is valid for this channel. */
export function createBotSender(options:{sdk:BotSdkPort;timeoutMs?:number;fileSdk?:BotFileSdkPort}){
 const {sdk,fileSdk}=options,timeout=options.timeoutMs??3000,closing=new AbortController();
 if(sdk.mode!=='isolated-synthetic'||!['ready','reply','sendMessage'].every(k=>typeof Reflect.get(sdk,k)==='function')||!Number.isInteger(timeout)||timeout<1||timeout>4000)throw Error('invalid_bot_sender');
 if(fileSdk&&(fileSdk.mode!=='isolated-synthetic'||typeof fileSdk.uploadMedia!=='function'||typeof fileSdk.sendMessage!=='function'))throw Error('invalid_bot_sender');
 const outcome=(state:BotSendOutcome['state'],detail:string):BotSendOutcome=>({state,apiErrorCode:null,msgid:null,detail});
 const safe=(v:unknown):v is string=>typeof v==='string'&&v.length>0&&v.length<=200&&!/[\u0000-\u0020]/.test(v);
 async function execute(scope:BotReadScope,beforeSend:(scope:BotReadScope)=>Promise<void>,invoke:(child:BotReadScope,markMessage:()=>void)=>Promise<unknown>,expectedReqId?:string,uploadMode=false):Promise<BotSendOutcome>{
  const deadline=Math.min(scope.deadline,performance.now()+timeout),signal=scope.signal;
  const expired=()=>closing.signal.aborted||signal.aborted||!Number.isFinite(deadline)||performance.now()>=deadline;
  if(expired())return outcome('blocked','budget_exhausted');
  const child=new AbortController();
  return new Promise(resolve=>{let done=false,attempted=false;
   const finish=(value:BotSendOutcome)=>{if(done)return;done=true;clearTimeout(timer);signal.removeEventListener('abort',cancel);closing.signal.removeEventListener('abort',cancel);child.abort();resolve(value);};
   const cancel=()=>finish(outcome(attempted?'unknown':'blocked',attempted?'send_result_unknown':uploadMode?'file_not_sent':'budget_exhausted'));
   const timer=setTimeout(cancel,Math.max(1,deadline-performance.now()));signal.addEventListener('abort',cancel,{once:true});closing.signal.addEventListener('abort',cancel,{once:true});
   const ack=(value:unknown,rejection=false):BotSendOutcome=>{
    const frame=value as {headers?:{req_id?:unknown};errcode?:unknown}|null,reqId=frame?.headers?.req_id,code=frame?.errcode;
    if(!safe(reqId)||expectedReqId!==undefined&&reqId!==expectedReqId||typeof code!=='number'||!Number.isSafeInteger(code)||code<0||rejection&&code===0)return outcome('unknown','send_result_unknown');
    return {state:code===0?'accepted':'rejected',apiErrorCode:code,msgid:null,detail:code===0?'sdk_ack_accepted':'sdk_ack_rejected',ackReqId:reqId};
   };
   void Promise.resolve().then(async()=>{
    if(expired()||done){cancel();return;}if(!sdk.ready()){finish(outcome('blocked','not_connected'));return;}
    await beforeSend({signal:child.signal,deadline});
    if(expired()||done){cancel();return;}if(!sdk.ready()){finish(outcome('blocked','not_connected'));return;}
    if(!uploadMode)attempted=true;
    const response=await invoke({signal:child.signal,deadline},()=>{if(done||expired()||child.signal.aborted)throw Error('send_cancelled');attempted=true;});if(!done){if(expired())cancel();else finish(ack(response));}
   }).catch(error=>{if(done)return;if(expired()){cancel();return;}finish(attempted?ack(error,true):outcome('blocked',uploadMode?'file_not_sent':'authority_refused'));});
  });
 }
 return {
 async file(member:string,filename:string,bytes:Uint8Array,scope:BotReadScope,beforeSend:(scope:BotReadScope)=>Promise<void>):Promise<BotSendOutcome>{
  if(!fileSdk||!safe(member)||member.length>120||!/^sales-[a-f0-9]{64}\.xlsx$/.test(filename)||!(bytes instanceof Uint8Array)||bytes.byteLength<5||bytes.byteLength>20_000_000)return outcome('blocked','file_not_sent');
  const copy=Buffer.from(bytes);
  return execute(scope,beforeSend,async(child,markMessage)=>{
   const media=structuredClone(await fileSdk.uploadMedia(copy,{type:'file',filename})) as {type?:unknown;media_id?:unknown}|null;
   if(!media||media.type!=='file'||typeof media.media_id!=='string'||!media.media_id||media.media_id.length>4096||/[\u0000-\u0020]/.test(media.media_id))throw Error('invalid_file_media');
   await beforeSend(child);if(child.signal.aborted||performance.now()>=child.deadline||!sdk.ready())throw Error('send_cancelled');
   markMessage();return fileSdk.sendMessage(member,{msgtype:'file',chat_type:1,file:{media_id:media.media_id}});
  },undefined,true);
 },
 reply(plan:BotReplyPlan,scope:BotReadScope,beforeSend:(scope:BotReadScope)=>Promise<void>){
  const copy=structuredClone(plan);if(!safe(copy.reqId)||typeof copy.body?.stream?.content!=='string'||!copy.body.stream.content.trim()||Buffer.byteLength(copy.body.stream.content)>16384)throw Error('invalid_bot_reply');
  return execute(scope,beforeSend,()=>sdk.reply({headers:{req_id:copy.reqId}},copy.body),copy.reqId);
 },
 notify(member:string,content:string,scope:BotReadScope,beforeSend:(scope:BotReadScope)=>Promise<void>){
  if(!safe(member)||member.length>120||typeof content!=='string'||!content.trim()||Buffer.byteLength(content)>16384)throw Error('invalid_bot_reply');
  return execute(scope,beforeSend,()=>sdk.sendMessage(member,{msgtype:'markdown',markdown:{content}}));
 },
 close(){closing.abort();}
 };
}
