import {createHash,randomUUID} from 'node:crypto';
import {WsCmd,type WSClient,type WsFrame,type UploadMediaInitBody,type UploadMediaChunkBody,type UploadMediaFinishBody} from '@wecom/aibot-node-sdk';
import type {BotReadScope} from './wecom-bot-context.js';
import type {BotSdkPort, BotFileSdkPort} from './wecom-bot-sender.js';
import {normalizeBotFrame,type BotCard} from './wecom-bot-transport.js';

const claimedClients=new WeakSet<object>(),notStarted=new WeakSet<object>();
/** Only this module can attest that its controlled boundary admitted no frame. */
export function isBotSdkNotStarted(error:unknown):boolean{return typeof error==='object'&&error!==null&&notStarted.has(error);}
const safe=(value:unknown,max=200):value is string=>typeof value==='string'&&value.length>0&&value.length<=max&&!/[\u0000-\u0020]/.test(value);
type Operation={scope:BotReadScope;epoch:number;admitted:boolean};

/** The owner must reserve this client exclusively for this adapter's business sends.
 * The adapter never connects/disconnects or patches SDK internals. Raw client sends
 * by the host violate that ownership contract. Already admitted bytes cannot be recalled. */
type SdkOptions={mode:'isolated-synthetic' | 'controlled-real-pilot';client:WSClient;maxRequestIds?:number;memberId?:string;botId?:string;corpId?:string;admit?:()=>boolean};
export function createBotSdkAdapter(options:{mode:'isolated-synthetic';client:WSClient;maxRequestIds?:number}){
 if(options.mode!=='isolated-synthetic')throw Error('invalid_bot_sdk');
 return createAdapter(options);
}
export function createControlledRealBotSdkAdapter(options:{mode:'controlled-real-pilot';client:WSClient;botId:string;corpId:string;memberId:string;admit:()=>boolean}){
 if(options.mode!=='controlled-real-pilot'||![options.memberId,options.botId,options.corpId].every(v=>safe(v,120))||typeof options.admit!=='function')throw Error('invalid_bot_sdk');
 return createAdapter(options);
}
function createAdapter(options:SdkOptions):BotSdkPort&BotFileSdkPort&{close():void}{
 const {client}=options,maxRequestIds=options.maxRequestIds??10000;
 if(!client||typeof client.reply!=='function'||typeof client.on!=='function'||typeof client.off!=='function'||!Number.isInteger(maxRequestIds)||maxRequestIds<1||maxRequestIds>10000)throw Error('invalid_bot_sdk');
 if(claimedClients.has(client))throw Error('sdk_client_claimed');
 claimedClients.add(client);
 const mode=options.mode,memberId=options.memberId,botId=options.botId,corpId=options.corpId,admit=options.admit;
 const callbacks=new Set<string>(),ids=new Set<string>();let authenticated=false,closed=false,epoch=0;
 const invalidate=()=>{authenticated=false;epoch++;callbacks.clear();};
 const authenticate=()=>{epoch++;authenticated=true;callbacks.clear();};
 const invalidatingEvents=['connected','disconnected','reconnecting','error','event.disconnected_event'] as const;
 for(const event of invalidatingEvents)client.on(event,invalidate);
 client.on('authenticated',authenticate);
 const ready=()=>!closed&&authenticated&&client.isConnected&&(!admit||admit());
 const callback=(raw:unknown)=>{
  if(mode!=='controlled-real-pilot'||!ready()||callbacks.size>=maxRequestIds)return;
  try{const e=normalizeBotFrame(structuredClone(raw));if(e.botId===botId&&e.memberId===memberId&&(e.corpId===undefined||e.corpId===corpId)&&e.action.kind==='text')callbacks.add(e.reqId);}catch{}
 };
 if(mode==='controlled-real-pilot')client.on('message.text',callback);
 const fail=(operation:Operation|undefined,code:string):never=>{
  const error=Error(code);if(!operation?.admitted)notStarted.add(error);throw error;
 };
 const check=(operation:Operation)=>{
  if(operation.scope.signal.aborted||!Number.isFinite(operation.scope.deadline)||performance.now()>=operation.scope.deadline)fail(operation,'sdk_cancelled');
  if(!ready()||operation.epoch!==epoch)fail(operation,'sdk_session_changed');
 };
 const begin=(scope:BotReadScope|undefined):Operation=>{
  if(!scope||!(scope.signal instanceof AbortSignal))return fail(undefined,'sdk_scope_required');
  const operation={scope:{signal:scope.signal,deadline:scope.deadline},epoch,admitted:false};check(operation);return operation;
 };
 const correlated=(value:unknown,reqId:string):value is WsFrame=>{
  const frame=value as WsFrame|undefined;
  return !!frame&&frame.headers?.req_id===reqId&&Number.isSafeInteger(frame.errcode)&&typeof frame.errcode==='number'&&frame.errcode>=0;
 };
 const wire=(operation:Operation,reqId:string,body:Record<string,unknown>,cmd:string):Promise<WsFrame>=>{
  check(operation);
  if(!safe(reqId)||reqId.startsWith(WsCmd.SUBSCRIBE)||reqId.startsWith(WsCmd.HEARTBEAT)||ids.has(reqId)||ids.size>=maxRequestIds)fail(operation,'sdk_request_not_admitted');
  if(mode==='controlled-real-pilot'&&cmd===WsCmd.RESPONSE&&!callbacks.has(reqId))fail(operation,'sdk_request_not_admitted');
  callbacks.delete(reqId);ids.add(reqId);operation.admitted=true;
  // Empty same-ID queue: SDK 1.0.7 reaches ws.send synchronously before reply returns.
  // IDs intentionally survive ACK, timeout, epoch changes, and adapter.close().
  let result:Promise<WsFrame>;
  try{result=client.reply({headers:{req_id:reqId}},body,cmd);}catch{throw Error('sdk_result_unknown');}
  return result.then(frame=>{
   check(operation);if(!correlated(frame,reqId))throw Error('sdk_result_unknown');
   if(frame.errcode!==0)throw frame;return frame;
  },error=>{
   check(operation);if(correlated(error,reqId)&&error.errcode!==0)throw error;
   throw Error('sdk_result_unknown');
  });
 };
 const fresh=(cmd:string)=>`${cmd}_${randomUUID()}`;
 const cardBody=(operation:Operation,card:BotCard):BotCard=>{
  if(card?.card_type!=='button_interaction'||!safe(card.task_id)||typeof card.main_title?.title!=='string'||!card.main_title.title.trim()||Buffer.byteLength(card.main_title.title)>128||card.main_title.desc!==undefined&&(typeof card.main_title.desc!=='string'||Buffer.byteLength(card.main_title.desc)>512)||!Array.isArray(card.button_list)||card.button_list.length<1||card.button_list.length>6)return fail(operation,'invalid_bot_card');
  const button_list=card.button_list.map(button=>{
   if(typeof button.text!=='string'||!button.text.trim()||button.text.length>200||!safe(button.key)||button.style!==1)return fail(operation,'invalid_bot_card');
   return {text:button.text,key:button.key,style:1 as const};
  });
  return {card_type:'button_interaction',task_id:card.task_id,main_title:{title:card.main_title.title,...(card.main_title.desc===undefined?{}:{desc:card.main_title.desc})},button_list};
 };
 return {
  mode,ready,
  async reply(frame,body,scope){
   const operation=begin(scope),copy=structuredClone(body);
   if(mode==='controlled-real-pilot'&&copy.msgtype!=='stream')return fail(operation,'invalid_bot_message');
   if(!['stream','stream_with_template_card'].includes(copy?.msgtype)||!safe(copy.stream?.id)||copy.stream.finish!==true||typeof copy.stream.content!=='string'||!copy.stream.content.trim()||Buffer.byteLength(copy.stream.content)>16384)return fail(operation,'invalid_bot_message');
   const content={msgtype:copy.msgtype,stream:{id:copy.stream.id,finish:true,content:copy.stream.content},...(copy.msgtype==='stream_with_template_card'?{template_card:cardBody(operation,copy.template_card!)}:{})};
   return wire(operation,frame.headers.req_id,content,WsCmd.RESPONSE);
  },
  async updateTemplateCard(frame,update,scope){
   const operation=begin(scope);if(mode==='controlled-real-pilot')return fail(operation,'invalid_bot_message');const copy=structuredClone(update),card=cardBody(operation,copy.card);
   if(!safe(copy.memberId,120)||typeof card.main_title.desc!=='string'||card.button_list.length!==1)return fail(operation,'invalid_bot_card');
   const button=card.button_list[0]!;
   if(button.text!=='核对结果'||!/^confirm:[a-f0-9]{64}$/.test(button.key)||button.style!==1)return fail(operation,'invalid_bot_card');
   const template_card={card_type:'button_interaction',task_id:card.task_id,main_title:{title:card.main_title.title,desc:card.main_title.desc},button_list:[{text:button.text,key:button.key,style:1}]};
   return wire(operation,frame.headers.req_id,{response_type:'update_template_card',template_card,userids:[copy.memberId]},WsCmd.RESPONSE_UPDATE);
  },
  async sendMessage(member,body,scope){
   const operation=begin(scope);if(!safe(member,120)||memberId!==undefined&&member!==memberId)return fail(operation,'invalid_bot_target');
   let content:Record<string,unknown>;
   if(body.msgtype==='markdown'){
    if(typeof body.markdown?.content!=='string'||!body.markdown.content.trim()||Buffer.byteLength(body.markdown.content)>16384)return fail(operation,'invalid_bot_message');
    content={msgtype:'markdown',markdown:{content:body.markdown.content}};
   }else{
    if(mode==='controlled-real-pilot'||body.msgtype!=='file'||!safe(body.file?.media_id,4096))return fail(operation,'invalid_bot_media');
    content={msgtype:'file',file:{media_id:body.file.media_id}};
   }
   return wire(operation,fresh(WsCmd.SEND_MSG),{chatid:member,chat_type:1,...content},WsCmd.SEND_MSG);
  },
  async uploadMedia(bytes,upload,scope){
   const operation=begin(scope);if(mode==='controlled-real-pilot')return fail(operation,'invalid_bot_upload');
   // Keep the original sender's conservative decimal 20 MB cap. The official
   // file protocol requires >=5 bytes and filenames <=256 UTF-8 bytes.
   if(!Buffer.isBuffer(bytes)||bytes.length<5||bytes.length>20_000_000||upload.type!=='file'||!safe(upload.filename,255)||Buffer.byteLength(upload.filename)>256)return fail(operation,'invalid_bot_upload');
   const copy=Buffer.from(bytes),filename=upload.filename,totalChunks=Math.ceil(copy.length/524288);
   const init:UploadMediaInitBody={type:'file',filename,total_size:copy.length,total_chunks:totalChunks,md5:createHash('md5').update(copy).digest('hex')};
   const initialized=await wire(operation,fresh(WsCmd.UPLOAD_MEDIA_INIT),{...init},WsCmd.UPLOAD_MEDIA_INIT);
   const uploadId=initialized.body?.upload_id;if(!safe(uploadId,4096))throw Error('invalid_bot_upload_result');
   for(let index=0;index<totalChunks;index++){
    check(operation);
    // Official upload protocol specifies zero-based order; pinned 1.0.7 CJS
    // agrees. Its d.ts's one-based comment is inconsistent with that protocol.
    const chunk:UploadMediaChunkBody={upload_id:uploadId,chunk_index:index,base64_data:copy.subarray(index*524288,Math.min((index+1)*524288,copy.length)).toString('base64')};
    await wire(operation,fresh(WsCmd.UPLOAD_MEDIA_CHUNK),{...chunk},WsCmd.UPLOAD_MEDIA_CHUNK);
   }
   const finish:UploadMediaFinishBody={upload_id:uploadId};
   const finished=await wire(operation,fresh(WsCmd.UPLOAD_MEDIA_FINISH),{...finish},WsCmd.UPLOAD_MEDIA_FINISH),media=finished.body;
   if(media?.type!=='file'||!safe(media.media_id,4096))throw Error('invalid_bot_upload_result');
   return {type:'file',media_id:media.media_id,created_at:media.created_at};
  },
  close(){if(closed)return;closed=true;invalidate();for(const event of invalidatingEvents)client.off(event,invalidate);client.off('authenticated',authenticate);if(mode==='controlled-real-pilot')client.off('message.text',callback);callbacks.clear();},
 };
}
