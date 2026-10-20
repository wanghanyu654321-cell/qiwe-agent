import {expect,it} from 'vitest';
import {createBotSender,type BotSdkPort} from '../../src/role-eval/wecom-bot-sender.js';
import type {BotReplyPlan} from '../../src/role-eval/wecom-bot-transport.js';
const plan:BotReplyPlan={reqId:'request-1',body:{msgtype:'stream',stream:{id:'stream-1',finish:true,content:'已入账，报告编号：合成'}}};
const budget=()=>({signal:new AbortController().signal,deadline:performance.now()+500});
function setup(){let calls=0,connected=true;let invoke:()=>Promise<unknown>=async()=>({headers:{req_id:'request-1'},errcode:0});const recipients:string[]=[];
 const sdk:BotSdkPort={mode:'isolated-synthetic',ready:()=>connected,reply:async(frame,body)=>{calls++;expect(frame.headers.req_id).toBe('request-1');expect(body.stream.content).toContain('已入账');return invoke();},sendMessage:async(member,body)=>{calls++;recipients.push(member);expect(body.msgtype).toBe('markdown');return invoke();}};
 const sender=createBotSender({sdk,timeoutMs:30});return {sender,getCalls:()=>calls,recipients,setInvoke:(fn:()=>Promise<unknown>)=>{invoke=fn;},disconnect:()=>{connected=false;}};
}
it('consumes SDK ACK without inventing an HTTP msgid',async()=>{const s=setup();expect(await s.sender.reply(plan,budget(),async()=>{})).toEqual({state:'accepted',apiErrorCode:0,msgid:null,detail:'sdk_ack_accepted',ackReqId:'request-1'});expect(s.getCalls()).toBe(1);});
it('sends proactive recovery only to the supplied trusted single userid',async()=>{const s=setup();expect((await s.sender.notify('member-original','已入账：1.23元',budget(),async()=>{})).state).toBe('accepted');expect(s.recipients).toEqual(['member-original']);});
it('classifies a correlated rejection frame without retrying it',async()=>{const s=setup();s.setInvoke(async()=>{throw {headers:{req_id:'request-1'},errcode:40001,errmsg:'synthetic-private'};});expect(await s.sender.reply(plan,budget(),async()=>{})).toMatchObject({state:'rejected',apiErrorCode:40001,detail:'sdk_ack_rejected'});expect(s.getCalls()).toBe(1);});
it.each([{headers:{req_id:'other'},errcode:0},{headers:{req_id:'request-1'}},{headers:{req_id:'request-1'},errcode:'0'}])('does not treat an ambiguous ACK as acceptance %j',async ack=>{const s=setup();s.setInvoke(async()=>ack);expect((await s.sender.reply(plan,budget(),async()=>{})).state).toBe('unknown');expect(s.getCalls()).toBe(1);});
it('returns blocked without an SDK invocation for disconnected, revoked or cancelled work',async()=>{const s=setup();s.disconnect();expect((await s.sender.reply(plan,budget(),async()=>{})).state).toBe('blocked');expect(s.getCalls()).toBe(0);
 const t=setup();expect((await t.sender.reply(plan,budget(),async()=>{throw Error('access_changed');})).state).toBe('blocked');expect((await t.sender.reply(plan,{...budget(),signal:AbortSignal.abort()},async()=>{})).state).toBe('blocked');expect(t.getCalls()).toBe(0);});
it('bounds slow authorization and prevents a late authorization from sending',async()=>{const s=setup();let release!:()=>void;const wait=new Promise<void>(r=>{release=r;});expect((await s.sender.reply(plan,budget(),()=>wait)).state).toBe('blocked');release();await new Promise<void>(r=>setImmediate(r));expect(s.getCalls()).toBe(0);});
it('bounds an ignored SDK promise and never upgrades late acceptance',async()=>{const s=setup();let release!:(v:unknown)=>void;s.setInvoke(()=>new Promise(r=>{release=r;}));const result=await s.sender.reply(plan,budget(),async()=>{});expect(result.state).toBe('unknown');release({headers:{req_id:'request-1'},errcode:0});await new Promise<void>(r=>setImmediate(r));expect(result.state).toBe('unknown');expect(s.getCalls()).toBe(1);});
it('records unknown when closed after invocation and blocked if closed before invocation',async()=>{const s=setup();s.sender.close();expect((await s.sender.reply(plan,budget(),async()=>{})).state).toBe('blocked');expect(s.getCalls()).toBe(0);
 const t=setup();t.setInvoke(async()=>{t.sender.close();return {headers:{req_id:'request-1'},errcode:0};});expect((await t.sender.reply(plan,budget(),async()=>{})).state).toBe('unknown');});
it('never exposes provider errors or accepts a production port',async()=>{const s=setup();s.setInvoke(async()=>{throw Error('synthetic-secret');});const result=await s.sender.reply(plan,budget(),async()=>{});expect(result.state).toBe('unknown');expect(JSON.stringify(result)).not.toContain('synthetic-secret');expect(()=>createBotSender({sdk:{mode:'production'} as unknown as BotSdkPort})).toThrow('invalid_bot_sender');});
it('forwards the bounded child scope to a controlled port',async()=>{
 let received:unknown;const sdk:BotSdkPort={mode:'isolated-synthetic',ready:()=>true,reply:async(_frame,_body,scope)=>{received=scope;return {headers:{req_id:'request-1'},errcode:0};},sendMessage:async()=>({})};
 const sender=createBotSender({sdk,timeoutMs:20}),parent=budget();expect((await sender.reply(plan,parent,async()=>{})).state).toBe('accepted');
 const child=received as ReturnType<typeof budget>;expect(child.signal).not.toBe(parent.signal);expect(child.signal.aborted).toBe(true);expect(child.deadline).toBeLessThan(parent.deadline);sender.close();
});
it('does not downgrade a card update into a stream if the update port is absent',async()=>{
 const s=setup(),update={memberId:'trusted',card:{card_type:'button_interaction' as const,task_id:'original-card',main_title:{title:'已核对',desc:'已处理'},button_list:[{text:'核对结果',key:'confirm:'+'a'.repeat(64),style:1 as const}]}};
 expect((await s.sender.reply({...plan,update},budget(),async()=>{})).state).toBe('blocked');expect(s.getCalls()).toBe(0);
});
it('routes a card update only through its specific port and retains the original callback ID',async()=>{
 const update={memberId:'trusted',card:{card_type:'button_interaction' as const,task_id:'original-card',main_title:{title:'已核对',desc:'已处理'},button_list:[{text:'核对结果',key:'confirm:'+'a'.repeat(64),style:1 as const}]}},calls:unknown[]=[];
 const sdk:BotSdkPort={mode:'isolated-synthetic',ready:()=>true,reply:async()=>{throw Error('stream_forbidden');},sendMessage:async()=>{throw Error('send_forbidden');},updateTemplateCard:async(frame,card,scope)=>{calls.push({frame,card,scope});return {headers:{req_id:'request-1'},errcode:0};}};
 const sender=createBotSender({sdk});expect((await sender.reply({...plan,update},budget(),async()=>{})).state).toBe('accepted');expect(calls).toHaveLength(1);expect(calls[0]).toMatchObject({frame:{headers:{req_id:'request-1'}},card:update});sender.close();
});
