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
/** Adapted from the existing application sender's bounded/preflight/result policy.
 * No HTTP credential flow or implicit network fallback is valid for this channel. */
export function createBotSender(options:{sdk:BotSdkPort;timeoutMs?:number}){
 const {sdk}=options,timeout=options.timeoutMs??3000,closing=new AbortController();
 if(sdk.mode!=='isolated-synthetic'||!['ready','reply','sendMessage'].every(k=>typeof Reflect.get(sdk,k)==='function')||!Number.isInteger(timeout)||timeout<1||timeout>4000)throw Error('invalid_bot_sender');
 const outcome=(state:BotSendOutcome['state'],detail:string):BotSendOutcome=>({state,apiErrorCode:null,msgid:null,detail});
 const safe=(v:unknown):v is string=>typeof v==='string'&&v.length>0&&v.length<=200&&!/[\u0000-\u0020]/.test(v);
 async function execute(scope:BotReadScope,beforeSend:(scope:BotReadScope)=>Promise<void>,invoke:()=>Promise<unknown>,expectedReqId?:string):Promise<BotSendOutcome>{
  const deadline=Math.min(scope.deadline,performance.now()+timeout),signal=scope.signal;
  const expired=()=>closing.signal.aborted||signal.aborted||!Number.isFinite(deadline)||performance.now()>=deadline;
  if(expired())return outcome('blocked','budget_exhausted');
  const child=new AbortController();
  return new Promise(resolve=>{let done=false,attempted=false;
   const finish=(value:BotSendOutcome)=>{if(done)return;done=true;clearTimeout(timer);signal.removeEventListener('abort',cancel);closing.signal.removeEventListener('abort',cancel);child.abort();resolve(value);};
   const cancel=()=>finish(outcome(attempted?'unknown':'blocked',attempted?'send_result_unknown':'budget_exhausted'));
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
    attempted=true;const response=await invoke();if(!done){if(expired())cancel();else finish(ack(response));}
   }).catch(error=>{if(done)return;if(expired()){cancel();return;}finish(attempted?ack(error,true):outcome('blocked','authority_refused'));});
  });
 }
 return {
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
