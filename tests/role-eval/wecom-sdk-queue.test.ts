import {afterEach,expect,it,vi} from 'vitest';
import {WSClient,WsCmd} from '@wecom/aibot-node-sdk';
import {createBotSender,type BotSdkPort,type BotFileSdkPort} from '../../src/role-eval/wecom-bot-sender.js';
type Frame={cmd?:string;headers:{req_id:string};body:Record<string,unknown>;errcode?:number};
type Manager={ws:unknown;handleFrame(frame:unknown):void;clearPendingMessages(reason:string):void;stopHeartbeat():void};
const cleanups:(()=>void)[]=[];
afterEach(()=>{for(const close of cleanups.splice(0).reverse())close();vi.useRealTimers();vi.restoreAllMocks();});
function fixture(){
 vi.useFakeTimers();const noop=()=>{};
 const client=new WSClient({botId:'synthetic-bot',secret:'synthetic-placeholder',logger:{debug:noop,info:noop,warn:noop,error:noop}});
 const connect=vi.spyOn(client,'connect').mockImplementation(()=>{throw Error('network_forbidden');});
 // Test-only replacement of the lowest I/O boundary. Real sendReply, queue,
 // JSON serialization and ACK handling remain unchanged in the installed SDK.
 const manager=Reflect.get(client,'wsManager') as Manager,wires:Frame[]=[];
 let receive:(frame:Frame)=>void=()=>{};
 manager.ws={readyState:1,send:(text:string)=>{const frame=JSON.parse(text) as Frame;wires.push(frame);queueMicrotask(()=>receive(frame));},terminate:noop,removeAllListeners:noop};
 cleanups.push(()=>{manager.clearPendingMessages('synthetic cleanup');manager.stopHeartbeat();manager.ws=null;expect(connect).not.toHaveBeenCalled();});
 const sdk:BotSdkPort={mode:'isolated-synthetic',ready:()=>client.isConnected,reply:(frame,body)=>client.reply(frame,body),sendMessage:(member,body)=>client.sendMessage(member,body)};
 const fileSdk:BotFileSdkPort={mode:'isolated-synthetic',uploadMedia:(bytes,options)=>client.uploadMedia(bytes,options),sendMessage:(member,body)=>client.sendMessage(member,body)};
 const sender=createBotSender({sdk,fileSdk,timeoutMs:20});cleanups.push(()=>sender.close());
 return {client,manager,wires,sender,receive:(work:typeof receive)=>{receive=work;},ack:(id:string,body:unknown={},errcode=0)=>manager.handleFrame({headers:{req_id:id},errcode,body})};
}
const plan=(id:string,content='final')=>({reqId:id,body:{msgtype:'stream' as const,stream:{id:'synthetic-stream',finish:true as const,content}}});
const budget=()=>({signal:new AbortController().signal,deadline:performance.now()+1000});
it('keeps sender unknown after its shorter timeout despite a later real SDK ACK',async()=>{
 const f=fixture(),result=f.sender.reply(plan('callback-id'),budget(),async()=>{});
 await vi.advanceTimersByTimeAsync(21);const outcome=await result;
 expect(f.wires).toHaveLength(1);expect(f.wires[0]).toMatchObject({cmd:WsCmd.RESPONSE,headers:{req_id:'callback-id'},body:{stream:{finish:true,content:'final'}}});
 expect(outcome.state).toBe('unknown');f.ack('callback-id');await vi.advanceTimersByTimeAsync(0);
 expect(await result).toBe(outcome);expect(outcome.state).toBe('unknown');expect(f.wires).toHaveLength(1);
});
it('documents that a real SDK queued reply can still reach the memory wire after local timeout',async()=>{
 const f=fixture(),first=f.client.reply({headers:{req_id:'same-callback'}},plan('same-callback','first').body);
 const pending=f.sender.reply(plan('same-callback','queued-final'),budget(),async()=>{});
 await vi.advanceTimersByTimeAsync(21);expect((await pending).state).toBe('unknown');expect(f.wires).toHaveLength(1);
 f.ack('same-callback');await first;await vi.advanceTimersByTimeAsync(0);
 expect(f.wires).toHaveLength(2);expect(f.wires[1]?.body).toMatchObject({stream:{content:'queued-final'}});
 f.ack('same-callback');await vi.advanceTimersByTimeAsync(0);expect((await pending).state).toBe('unknown');
 // This is a reproduced release blocker, not a cancellation guarantee. Runtime
 // assembly therefore accepts only explicit synthetic send ports in this stage.
});
it('records the same-request late ACK attribution boundary instead of treating SDK queue sequence as a receipt ID',async()=>{
 const f=fixture(),first=f.client.reply({headers:{req_id:'same-id'}},plan('same-id','first').body).then(()=>null,(error:Error)=>error);
 const second=f.client.reply({headers:{req_id:'same-id'}},plan('same-id','second').body);
 await vi.advanceTimersByTimeAsync(5001);expect(await first).toBeInstanceOf(Error);expect(f.wires).toHaveLength(2);
 f.ack('same-id',{syntheticLateAckFor:'first'});const receipt=await second;
 expect(receipt.body).toEqual({syntheticLateAckFor:'first'});
});
it('allows SDK chunk retries to finish after timeout but never sends the final file message',async()=>{
 const f=fixture();let chunks=0;
 f.receive(frame=>{
  if(frame.cmd===WsCmd.UPLOAD_MEDIA_INIT)f.ack(frame.headers.req_id,{upload_id:'synthetic-upload'});
  else if(frame.cmd===WsCmd.UPLOAD_MEDIA_CHUNK)f.ack(frame.headers.req_id,{},++chunks===1?500:0);
  else if(frame.cmd===WsCmd.UPLOAD_MEDIA_FINISH)f.ack(frame.headers.req_id,{type:'file',media_id:'synthetic-media',created_at:1});
  else throw Error('final_file_send_must_not_run');
 });
 const result=f.sender.file('member','sales-'+'a'.repeat(64)+'.xlsx',Buffer.from('synthetic-file'),budget(),async()=>{});
 await vi.advanceTimersByTimeAsync(21);expect((await result).state).toBe('blocked');expect(chunks).toBe(1);
 await vi.advanceTimersByTimeAsync(600);expect(chunks).toBe(2);
 expect(f.wires.map(w=>w.cmd)).toEqual([WsCmd.UPLOAD_MEDIA_INIT,WsCmd.UPLOAD_MEDIA_CHUNK,WsCmd.UPLOAD_MEDIA_CHUNK,WsCmd.UPLOAD_MEDIA_FINISH]);
 expect((await result).state).toBe('blocked');
});
