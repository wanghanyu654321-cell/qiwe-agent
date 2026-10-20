import {createRequire} from 'node:module';
import {createHash} from 'node:crypto';
import {afterEach,expect,it,vi} from 'vitest';
import type {WsFrame} from '@wecom/aibot-node-sdk';
import {createBotSdkAdapter,isBotSdkNotStarted} from '../../src/role-eval/wecom-bot-sdk.js';
import {createBotSender} from '../../src/role-eval/wecom-bot-sender.js';

const {WSClient}=createRequire(import.meta.url)('@wecom/aibot-node-sdk') as typeof import('@wecom/aibot-node-sdk');
const cleanup:(()=>void)[]=[];
afterEach(()=>{cleanup.splice(0).reverse().forEach(fn=>fn());vi.useRealTimers();});
const scope=()=>({signal:new AbortController().signal,deadline:performance.now()+4000});
const plan={reqId:'callback-1',body:{msgtype:'stream' as const,stream:{id:'stream',finish:true as const,content:'synthetic'}}};
function fixture(maxRequestIds?:number){
 const client=new WSClient({botId:'synthetic-bot',secret:'synthetic-placeholder',logger:{debug(){},info(){},warn(){},error(){}}});
 const connect=vi.spyOn(client,'connect').mockImplementation(()=>{throw Error('network_forbidden');});
 const disconnect=vi.spyOn(client,'disconnect').mockImplementation(()=>{throw Error('network_forbidden');});
 const manager=Reflect.get(client,'wsManager') as {ws:unknown;handleFrame(frame:WsFrame):void;onAuthenticated():void;onConnected():void;onReconnecting(n:number):void;clearPendingMessages(reason:string):void};
 const sent:WsFrame<Record<string,unknown>>[]=[];
 let respond:((frame:WsFrame<Record<string,unknown>>)=>void)|undefined;
 manager.ws={readyState:1,send(data:string){const frame=JSON.parse(data) as WsFrame<Record<string,unknown>>;sent.push(frame);queueMicrotask(()=>{if(respond)respond(frame);else ack(frame);});}};
 const ack=(frame:WsFrame,body:Record<string,unknown>={},errcode=0)=>manager.handleFrame({headers:{req_id:frame.headers.req_id},errcode,body});
 const adapter=createBotSdkAdapter({mode:'isolated-synthetic',client,...(maxRequestIds===undefined?{}:{maxRequestIds})});
 cleanup.push(()=>{adapter.close();manager.clearPendingMessages('test_end');expect(connect).not.toHaveBeenCalled();expect(disconnect).not.toHaveBeenCalled();});
 return {client,adapter,sent,ack,manager,authenticate:()=>manager.onAuthenticated(),respond:(fn:typeof respond)=>{respond=fn;}};
}

it('starts unauthenticated, admits a single synchronous SDK reply and preserves its correlated ACK',async()=>{
 const s=fixture();expect(s.adapter.ready()).toBe(false);s.authenticate();expect(s.adapter.ready()).toBe(true);
 const result=s.adapter.reply({headers:{req_id:'callback-1'}},plan.body,scope());
 expect(s.sent).toEqual([{cmd:'aibot_respond_msg',headers:{req_id:'callback-1'},body:plan.body}]);
 expect(await result).toMatchObject({headers:{req_id:'callback-1'},errcode:0});
});
it('marks pre-admission cancellation as trusted not-started and sends zero bytes',async()=>{
 const s=fixture();s.authenticate();const error=await s.adapter.reply({headers:{req_id:'callback'}},plan.body,{...scope(),signal:AbortSignal.abort()}).catch(e=>e);
 expect(isBotSdkNotStarted(error)).toBe(true);expect(isBotSdkNotStarted(Error('sdk_not_started'))).toBe(false);expect(s.sent).toHaveLength(0);
});
it('never reuses a callback request ID after an ACK or new authenticated epoch',async()=>{
 const s=fixture();s.authenticate();await s.adapter.reply({headers:{req_id:'same'}},plan.body,scope());s.manager.onReconnecting(1);s.authenticate();
 const error=await s.adapter.reply({headers:{req_id:'same'}},plan.body,scope()).catch(e=>e);expect(isBotSdkNotStarted(error)).toBe(true);expect(s.sent).toHaveLength(1);
 expect(()=>createBotSdkAdapter({mode:'isolated-synthetic',client:s.client})).toThrow('sdk_client_claimed');
});
it('fails closed at lifetime capacity without admitting another ID',async()=>{
 const s=fixture(1);s.authenticate();await s.adapter.reply({headers:{req_id:'one'}},plan.body,scope());
 const error=await s.adapter.reply({headers:{req_id:'two'}},plan.body,scope()).catch(e=>e);expect(isBotSdkNotStarted(error)).toBe(true);expect(s.sent).toHaveLength(1);
});
it('uses fresh proactive IDs and a whitelisted single-chat body',async()=>{
 const s=fixture();s.authenticate();const body={msgtype:'markdown' as const,markdown:{content:'hello'},chatid:'attacker',chat_type:2};
 await s.adapter.sendMessage('trusted',body,scope());await s.adapter.sendMessage('trusted',body,scope());
 expect(s.sent.map(frame=>frame.body)).toEqual([{chatid:'trusted',chat_type:1,msgtype:'markdown',markdown:{content:'hello'}},{chatid:'trusted',chat_type:1,msgtype:'markdown',markdown:{content:'hello'}}]);
 expect(s.sent[0]!.headers.req_id).not.toBe(s.sent[1]!.headers.req_id);expect(s.sent.every(frame=>frame.cmd==='aibot_send_msg')).toBe(true);
});
it('does not accept a wrong proactive ACK and does not retry after timeout',async()=>{
 vi.useFakeTimers();const s=fixture();s.authenticate();s.respond(frame=>s.manager.handleFrame({headers:{req_id:'wrong'},errcode:0}));
 const sender=createBotSender({sdk:s.adapter,timeoutMs:20});const result=sender.notify('trusted','hello',scope(),async()=>{});
 await vi.advanceTimersByTimeAsync(21);expect((await result).state).toBe('unknown');await vi.advanceTimersByTimeAsync(5000);expect(s.sent).toHaveLength(1);sender.close();
});
it('sends MD5 init, sequential zero-based fixed-SDK chunks and finish without retry',async()=>{
 const s=fixture();s.authenticate();const bytes=Buffer.alloc(524289,97);
 s.respond(frame=>s.ack(frame,frame.cmd==='aibot_upload_media_init'?{upload_id:'upload'}:frame.cmd==='aibot_upload_media_finish'?{type:'file',media_id:'media',created_at:'synthetic'}:{}));
 expect(await s.adapter.uploadMedia(bytes,{type:'file',filename:'synthetic.xlsx'},scope())).toEqual({type:'file',media_id:'media',created_at:'synthetic'});
 expect(s.sent.map(frame=>frame.cmd)).toEqual(['aibot_upload_media_init','aibot_upload_media_chunk','aibot_upload_media_chunk','aibot_upload_media_finish']);
 expect(s.sent[0]!.body).toEqual({type:'file',filename:'synthetic.xlsx',total_size:524289,total_chunks:2,md5:createHash('md5').update(bytes).digest('hex')});
 expect(s.sent[1]!.body).toEqual({upload_id:'upload',chunk_index:0,base64_data:Buffer.alloc(524288,97).toString('base64')});expect(s.sent[2]!.body).toEqual({upload_id:'upload',chunk_index:1,base64_data:'YQ=='});
 expect(new Set(s.sent.map(frame=>frame.headers.req_id)).size).toBe(4);
});
it('does not admit any later upload frame after cancellation despite late init success',async()=>{
 const s=fixture();s.authenticate();const controller=new AbortController();let init:WsFrame|undefined;s.respond(frame=>{init=frame;});
 const result=s.adapter.uploadMedia(Buffer.from('synthetic'),{type:'file',filename:'synthetic.xlsx'},{...scope(),signal:controller.signal}).catch(e=>e);
 await Promise.resolve();controller.abort();s.ack(init!,{upload_id:'late'});expect(isBotSdkNotStarted(await result)).toBe(false);expect(s.sent).toHaveLength(1);
});
it('stops all later media frames when authentication changes between ACKs',async()=>{
 const s=fixture();s.authenticate();s.respond(frame=>{s.manager.onReconnecting(1);s.authenticate();s.ack(frame,{upload_id:'old-epoch'});});
 await expect(s.adapter.uploadMedia(Buffer.from('synthetic'),{type:'file',filename:'synthetic.xlsx'},scope())).rejects.toThrow();expect(s.sent).toHaveLength(1);
});
it('does not retry a rejected media chunk or send finish',async()=>{
 const s=fixture();s.authenticate();s.respond(frame=>s.ack(frame,frame.cmd==='aibot_upload_media_init'?{upload_id:'upload'}:{},frame.cmd==='aibot_upload_media_chunk'?40001:0));
 await expect(s.adapter.uploadMedia(Buffer.from('synthetic'),{type:'file',filename:'synthetic.xlsx'},scope())).rejects.toMatchObject({errcode:40001});expect(s.sent.map(frame=>frame.cmd)).toEqual(['aibot_upload_media_init','aibot_upload_media_chunk']);
});
it('classifies the controlled adapter no-admission failure as sender blocked',async()=>{
 const s=fixture(1);s.authenticate();await s.adapter.reply({headers:{req_id:'callback-1'}},plan.body,scope());
 const sender=createBotSender({sdk:s.adapter});expect((await sender.reply(plan,scope(),async()=>{})).state).toBe('blocked');expect(s.sent).toHaveLength(1);sender.close();
});
it('uses the update command, original task ID and explicit trusted userids without a stream',async()=>{
 const s=fixture();s.authenticate();const update={memberId:'trusted',card:{card_type:'button_interaction' as const,task_id:'original-card',main_title:{title:'已核对',desc:'合成结果'},button_list:[{text:'核对结果',key:'confirm:'+'a'.repeat(64),style:1 as const}]}};
 await s.adapter.updateTemplateCard!({headers:{req_id:'card-callback'}},update,scope());
 expect(s.sent).toEqual([{cmd:'aibot_respond_update_msg',headers:{req_id:'card-callback'},body:{response_type:'update_template_card',template_card:update.card,userids:['trusted']}}]);
});
it('rejects a mismatched direct SDK ACK even for a proactive send',async()=>{
 const s=fixture();s.authenticate();vi.spyOn(s.client,'reply').mockResolvedValueOnce({headers:{req_id:'wrong'},errcode:0});
 const sender=createBotSender({sdk:s.adapter});expect((await sender.notify('trusted','synthetic',scope(),async()=>{})).state).toBe('unknown');sender.close();
});
it('keeps timed-out IDs spent and ignores a late ACK while a different request is pending',async()=>{
 vi.useFakeTimers();const s=fixture();s.authenticate();s.respond(()=>{});
 const first=s.adapter.reply({headers:{req_id:'old'}},plan.body,{...scope(),deadline:performance.now()+10000}).catch(e=>e);
 await vi.advanceTimersByTimeAsync(5001);expect(await first).toBeInstanceOf(Error);
 const duplicate=await s.adapter.reply({headers:{req_id:'old'}},plan.body,scope()).catch(e=>e);expect(isBotSdkNotStarted(duplicate)).toBe(true);
 let resolved=false;const next=s.adapter.reply({headers:{req_id:'new'}},plan.body,scope()).then(value=>{resolved=true;return value;});
 s.ack({headers:{req_id:'old'}});await Promise.resolve();expect(resolved).toBe(false);s.ack({headers:{req_id:'new'}});expect(await next).toMatchObject({headers:{req_id:'new'}});expect(s.sent.map(frame=>frame.headers.req_id)).toEqual(['old','new']);
});
it('rejects missing scope, oversized uploads and reserved ACK-routing IDs before admission',async()=>{
 const s=fixture();s.authenticate();
 for(const invoke of [()=>s.adapter.reply({headers:{req_id:'no-scope'}},plan.body),()=>s.adapter.reply({headers:{req_id:'ping-unsafe'}},plan.body,scope()),()=>s.adapter.uploadMedia(Buffer.alloc(524288*100+1),{type:'file',filename:'synthetic.xlsx'},scope())])expect(isBotSdkNotStarted(await invoke().catch(e=>e))).toBe(true);
 expect(s.sent).toHaveLength(0);
});
it('rebuilds reply bodies and nested card fields without arbitrary runtime additions',async()=>{
 const s=fixture();s.authenticate();const body={msgtype:'stream_with_template_card' as const,stream:{...plan.body.stream,extra:'drop'},chatid:'unknown-chat',response_type:'wrong',template_card:{card_type:'button_interaction' as const,task_id:'original-card',main_title:{title:'核对',url:'drop'},button_list:[{text:'确认入账',key:'confirm:'+'b'.repeat(64),style:1 as const,userid:'drop'}],userids:['other']}};
 await s.adapter.reply({headers:{req_id:'card-source'}},body,scope());
 expect(s.sent[0]!.body).toEqual({msgtype:'stream_with_template_card',stream:plan.body.stream,template_card:{card_type:'button_interaction',task_id:'original-card',main_title:{title:'核对'},button_list:[{text:'确认入账',key:'confirm:'+'b'.repeat(64),style:1}]}});
});
it('sends a file only after sequential media completion and correlates the generated final ID',async()=>{
 const s=fixture();s.authenticate();s.respond(frame=>s.ack(frame,frame.cmd==='aibot_upload_media_init'?{upload_id:'upload'}:frame.cmd==='aibot_upload_media_finish'?{type:'file',media_id:'media'}:{}));
 const sender=createBotSender({sdk:s.adapter,fileSdk:s.adapter}),filename='sales-'+'a'.repeat(64)+'.xlsx';
 const result=await sender.file('trusted',filename,Buffer.from('PK-synthetic'),scope(),async()=>{});
 expect(result).toMatchObject({state:'accepted',ackReqId:s.sent.at(-1)!.headers.req_id});expect(s.sent.map(frame=>frame.cmd)).toEqual(['aibot_upload_media_init','aibot_upload_media_chunk','aibot_upload_media_finish','aibot_send_msg']);expect(s.sent.at(-1)!.body).toEqual({chatid:'trusted',chat_type:1,msgtype:'file',file:{media_id:'media'}});sender.close();
});
it('keeps upload timeout file_not_sent and never admits a late finish or file message',async()=>{
 vi.useFakeTimers();const s=fixture();s.authenticate();let held:WsFrame|undefined;
 s.respond(frame=>{if(frame.cmd==='aibot_upload_media_init')s.ack(frame,{upload_id:'upload'});else held=frame;});
 const sender=createBotSender({sdk:s.adapter,fileSdk:s.adapter,timeoutMs:20});
 const pending=sender.file('trusted','sales-'+'a'.repeat(64)+'.xlsx',Buffer.from('PK-synthetic'),scope(),async()=>{});
 await vi.advanceTimersByTimeAsync(21);expect(await pending).toMatchObject({state:'blocked',detail:'file_not_sent'});expect(s.sent).toHaveLength(2);
 s.ack(held!);await vi.advanceTimersByTimeAsync(0);expect(s.sent).toHaveLength(2);sender.close();
});
it('refuses a final file message at spent-ID capacity without relabeling it unknown',async()=>{
 const s=fixture(3);s.authenticate();s.respond(frame=>s.ack(frame,frame.cmd==='aibot_upload_media_init'?{upload_id:'upload'}:frame.cmd==='aibot_upload_media_finish'?{type:'file',media_id:'media'}:{}));
 const sender=createBotSender({sdk:s.adapter,fileSdk:s.adapter});expect(await sender.file('trusted','sales-'+'a'.repeat(64)+'.xlsx',Buffer.from('PK-synthetic'),scope(),async()=>{})).toMatchObject({state:'blocked',detail:'file_not_sent'});expect(s.sent.map(frame=>frame.cmd)).toEqual(['aibot_upload_media_init','aibot_upload_media_chunk','aibot_upload_media_finish']);sender.close();
});
