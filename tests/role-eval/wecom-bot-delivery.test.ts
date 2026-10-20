import {afterEach,expect,it} from 'vitest';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {ManagerStore} from '../../src/role-eval/manager-store.js';
import {WorkbenchAccessStore} from '../../src/role-eval/workbench-access.js';
import {createWecomBotContext} from '../../src/role-eval/wecom-bot-context.js';
import {createBotSender,type BotSdkPort} from '../../src/role-eval/wecom-bot-sender.js';
import {createBotDelivery} from '../../src/role-eval/wecom-bot-delivery.js';
import type {BotReplyPlan} from '../../src/role-eval/wecom-bot-transport.js';
const cleanups:(()=>void)[]=[];afterEach(()=>{for(const close of cleanups.splice(0).reverse())close();});
function setup(home='web:home-a'){
 const dir=mkdtempSync(join(tmpdir(),'bot-delivery-'));cleanups.push(()=>rmSync(dir,{recursive:true,force:true}));
 const file=join(dir,'reports.sqlite'),ledger=new ManagerStore(file),grants=new WorkbenchAccessStore(join(dir,'access.sqlite'));cleanups.push(()=>ledger.close(),()=>grants.close());
 let member='member-a',account='a',ready=true,frame:unknown,readyHook=()=>{},invoke:(reqId:string)=>Promise<unknown>=async reqId=>({headers:{req_id:reqId},errcode:0});
 grants.change('admin',{accountId:'a',storeId:'b',roles:['manager'],active:true,expectedVersion:0,requestKey:'open-a'});grants.change('admin',{accountId:'b',storeId:'b',roles:['manager'],active:true,expectedVersion:0,requestKey:'open-b'});
 const actor={tenant:'t',store:'b',workspace:'web:old-ledger',employeeId:'original-a',employeeName:'合成美容师'};
 const authority=createWecomBotContext({mode:'isolated-synthetic',botId:'bot',corpId:'corp',tenantId:'t',stores:[{id:'b'}],roles:['manager'],store:grants,readSubject:async()=>({botId:'bot',memberId:member}),readBinding:async()=>({botId:'bot',corpId:'corp',memberId:member,accountId:account,version:1,active:true}),readNative:async id=>({user:{id,role:'member',status:'active',must_change_password:false},workspaceJid:id==='a'?home:'web:home-b'})});cleanups.push(()=>authority.close());
 const replies:{reqId:string;body:BotReplyPlan['body']}[]=[],notifications:{member:string;content:string}[]=[];
 const cardUpdate:NonNullable<BotSdkPort['updateTemplateCard']>=async(f,update)=>{replies.push({reqId:f.headers.req_id,body:{msgtype:'stream',stream:{id:f.headers.req_id,finish:true,content:update.card.main_title.desc!}}});return invoke(f.headers.req_id);};
 const sdk:BotSdkPort={mode:'isolated-synthetic',ready:()=>{readyHook();return ready;},reply:async(f,body)=>{replies.push({reqId:f.headers.req_id,body:structuredClone(body)});return invoke(f.headers.req_id);},sendMessage:async(id,body)=>{notifications.push({member:id,content:body.markdown.content});return invoke('proactive-ack');}};
 sdk.updateTemplateCard=cardUpdate;
 const make=(store=ledger)=>{const sender=createBotSender({sdk,timeoutMs:35});const app=createBotDelivery({mode:'isolated-synthetic',authority,ledger:store,scope:{tenant:'t',store:'b',workspace:'web:old-ledger'},employees:[{accountId:'a',employeeId:'original-a',employeeName:'合成美容师'},{accountId:'b',employeeId:'original-b',employeeName:'合成员工乙'}],readEvent:()=>frame,now:()=>new Date('2026-10-17T01:00:00Z'),sender});cleanups.push(()=>app.close());return app;};
 const app=make(),request=()=>({correlationId:'delivery',signal:new AbortController().signal,deadline:performance.now()+1000});
 const text=(content='今天销售成交88.88元',id='text-1')=>{frame={cmd:'aibot_msg_callback',headers:{req_id:'req-'+id},body:{aibotid:'bot',msgid:id,chattype:'single',from:{userid:member},msgtype:'text',text:{content}}};};
 const confirm=(id:string,hash:string,eventId='confirm-1')=>{frame={cmd:'aibot_event_callback',headers:{req_id:'req-'+eventId},body:{aibotid:'bot',msgid:eventId,chattype:'single',from:{userid:member},msgtype:'event',event:{eventtype:'template_card_event',task_id:'report-'+id+'-'+'a'.repeat(32),event_key:'confirm:'+hash}}};};
 const seed=()=>{const r=ledger.receiveBot(actor,'seed','今天销售成交88.88元','2026-10-17',{kind:'wecom-bot',corpId:'corp',botId:'bot',memberId:'member-a',messageId:'source-seed',accountId:'a',workspaceJid:'web:home-a',storeId:'b',bindingVersion:1});return ledger.confirm(actor,r.id,r.hash,r.proposed.items);};
 return {file,ledger,grants,actor,app,make,authority,replies,notifications,request,text,confirm,seed,disconnect:()=>{ready=false;},connect:()=>{ready=true;},setReadyHook:(fn:()=>void)=>{readyHook=fn;},setReqId:(id:string)=>{(frame as {headers:{req_id:string}}).headers.req_id=id;},setInvoke:(fn:typeof invoke)=>{invoke=fn;},switchMember:()=>{member='member-b';account='b';},reopen:()=>{const second=new ManagerStore(file);cleanups.push(()=>second.close());return make(second);}};
}
it('delivers pending card, committed confirmation and a fresh query through the isolated SDK port',async()=>{const s=setup();s.text();const p=await s.app.handle(s.request());expect(p.delivery?.state).toBe('accepted');expect(s.replies[0]?.body.template_card).toBeDefined();const r=s.ledger.getReport(s.actor,p.result.reportId!)!;
 s.confirm(r.id,r.hash);const c=await s.app.handle(s.request());expect(c.reportDelivery).toMatchObject({state:'accepted',attempt:1,ackReqId:'req-confirm-1',msgid:null});expect(s.ledger.summary(s.actor,'2026-10-17','month').salesCents).toBe(8888);
 s.text('查询 '+r.id,'query-1');expect((await s.app.handle(s.request())).delivery?.state).toBe('accepted');expect(s.replies).toHaveLength(3);expect(s.notifications).toEqual([]);
});
it('suppresses duplicate events and confirmation notifications across independent connections',async()=>{const s=setup();s.text();const first=await s.app.handle(s.request());await s.reopen().handle(s.request());expect(s.replies).toHaveLength(1);const r=s.ledger.getReport(s.actor,first.result.reportId!)!;s.confirm(r.id,r.hash);
 await Promise.all([s.app.handle(s.request()),s.reopen().handle(s.request())]);expect(s.replies).toHaveLength(2);await s.reopen().recover(s.request(),r.id);expect(s.notifications).toEqual([]);expect(s.ledger.getReport(s.actor,r.id)?.delivery?.attempt).toBe(1);
});
it.each(['blocked','unknown'] as const)('keeps pre-T7b confirmation fingerprints compatible for %s persisted delivery',async state=>{
 const s=setup(),r=s.seed();s.confirm(r.id,r.hash);if(state==='blocked')s.disconnect();else s.setInvoke(async()=>{throw Error('synthetic-unknown');});
 await s.app.handle(s.request());
 const hash=(v:unknown)=>createHash('sha256').update(JSON.stringify(v)).digest('hex');
 const id=hash(['corp','bot','member-a','confirm-1']);
 const db=new DatabaseSync(s.file);try{
  const raw=db.prepare('SELECT body FROM bot_reply_intents WHERE id=?').get(id) as {body:string};const row=JSON.parse(raw.body);
  row.fingerprint=hash(['bot','member-a','confirm-1',null,{kind:'confirm',reportId:r.id,hash:r.hash}]);
  row.delivery.confirmationHash=row.fingerprint;delete row.reply.update;
  db.prepare('UPDATE bot_reply_intents SET body=? WHERE id=?').run(JSON.stringify(row),id);
 }finally{db.close();}
 const previous=s.replies.length;s.connect();s.setInvoke(async reqId=>({headers:{req_id:reqId},errcode:0}));
 const result=await s.reopen().handle(s.request());
 expect(result.delivery?.state).toBe(state==='blocked'?'accepted':'unknown');expect(s.replies.length-previous).toBe(state==='blocked'?1:0);
 expect(s.ledger.getReport(s.actor,r.id)?.entries).toHaveLength(1);
 if(state==='blocked')expect(s.ledger.getBotReply(s.actor,id)?.reply.update?.card.task_id).toContain(r.id);
});
it('recovers a definitely unsent blocked confirmation using the original single recipient',async()=>{const s=setup();const r=s.seed();s.disconnect();s.confirm(r.id,r.hash);expect((await s.app.handle(s.request())).reportDelivery?.state).toBe('blocked');expect(s.replies).toEqual([]);
 s.connect();const result=await s.reopen().recover(s.request(),r.id);expect(result.delivery.state).toBe('accepted');expect(s.notifications).toHaveLength(1);expect(s.notifications[0]).toMatchObject({member:'member-a'});expect(s.notifications[0]?.content).toContain('88.88元');expect(s.notifications[0]?.content).not.toContain('http');await s.app.recover(s.request(),r.id);expect(s.notifications).toHaveLength(1);
});
it('retains unknown confirmation on restart, suppresses resend and lets a new explicit query succeed',async()=>{const s=setup();const r=s.seed();s.confirm(r.id,r.hash);s.setInvoke(async()=>{throw Error('synthetic-network-secret');});const unknown=await s.app.handle(s.request());expect(unknown.reportDelivery?.state).toBe('unknown');expect(s.replies).toHaveLength(1);
 s.setInvoke(async reqId=>({headers:{req_id:reqId},errcode:0}));await s.reopen().recover(s.request(),r.id);await s.reopen().handle(s.request());expect(s.notifications).toEqual([]);expect(s.replies).toHaveLength(1);
 s.text('查询 '+r.id,'query-after-unknown');expect((await s.app.handle(s.request())).delivery?.state).toBe('accepted');expect(s.replies).toHaveLength(2);expect(s.replies[1]?.body.stream.content).toContain('结果未知');expect(s.ledger.getReport(s.actor,r.id)?.delivery?.state).toBe('unknown');
});
it('keeps a crash-left attempting report and rejects cross-member recovery',async()=>{const s=setup();const r=s.seed();s.ledger.claimReturn(s.actor,r.id);expect((await s.reopen().recover(s.request(),r.id)).delivery.state).toBe('attempting');expect(s.notifications).toEqual([]);s.switchMember();await expect(s.app.recover(s.request(),r.id)).rejects.toThrow('report_not_found');});
it('records platform rejection without undoing the confirmed report or auto retrying',async()=>{const s=setup();const r=s.seed();s.confirm(r.id,r.hash);s.setInvoke(async reqId=>{throw {headers:{req_id:reqId},errcode:40001};});expect((await s.app.handle(s.request())).reportDelivery).toMatchObject({state:'rejected',apiErrorCode:40001});await s.reopen().recover(s.request(),r.id);expect(s.replies).toHaveLength(1);expect(s.notifications).toEqual([]);expect(s.ledger.getReport(s.actor,r.id)?.state).toBe('confirmed');});
it('does not execute a transport after revocation or cancellation',async()=>{const s=setup();const r=s.seed();s.grants.change('admin',{accountId:'a',storeId:'b',roles:['manager'],active:false,expectedVersion:1,requestKey:'revoke'});await expect(s.app.recover(s.request(),r.id)).rejects.toThrow('access_denied');expect(s.notifications).toEqual([]);
 const t=setup();t.text();await expect(t.app.handle({...t.request(),signal:AbortSignal.abort()})).rejects.toThrow('authority_cancelled');expect(t.replies).toEqual([]);
});
it('retains attempting if an accepted ACK cannot be persisted and never sends it again',async()=>{const s=setup();const r=s.seed();s.confirm(r.id,r.hash);const original=s.ledger.finishBotReply.bind(s.ledger);s.ledger.finishBotReply=()=>{throw Error('synthetic-disk-fault');};expect((await s.app.handle(s.request()))).toMatchObject({deferred:true,reportDelivery:{state:'attempting'}});s.ledger.finishBotReply=original;
 await s.reopen().recover(s.request(),r.id);expect(s.replies).toHaveLength(1);expect(s.notifications).toEqual([]);expect(s.ledger.getReport(s.actor,r.id)?.state).toBe('confirmed');});
it('does not report a stale prepared state if the post-send status read is unavailable',async()=>{
 const s=setup();const r=s.seed();s.confirm(r.id,r.hash);const read=s.ledger.getReport.bind(s.ledger);
 s.setInvoke(async reqId=>{s.ledger.getReport=()=>{throw Error('synthetic-read-failure');};return {headers:{req_id:reqId},errcode:0};});
 const result=await s.app.handle(s.request());expect(result).toMatchObject({deferred:true,reportDelivery:{state:'accepted',attempt:1}});s.ledger.getReport=read;expect(s.ledger.getReport(s.actor,r.id)?.delivery?.state).toBe('accepted');
});
it('refuses a changed confirmation event before touching a second pending report',async()=>{
 const s=setup();s.text('2026-10-17销售成交1元','r1');const first=await s.app.handle(s.request());s.text('2026-10-18销售成交2元','r2');const second=await s.app.handle(s.request());
 const a=s.ledger.getReport(s.actor,first.result.reportId!)!,b=s.ledger.getReport(s.actor,second.result.reportId!)!;
 s.confirm(a.id,a.hash,'same-event');await s.app.handle(s.request());s.confirm(b.id,b.hash,'same-event');await expect(s.app.handle(s.request())).rejects.toThrow('bot_reply_conflict');
 expect(s.ledger.getReport(s.actor,b.id)?.state).toBe('pending');expect(s.ledger.summary(s.actor,'2026-10-17','month').salesCents).toBe(100);expect(s.replies).toHaveLength(3);
});
it('reserves a callback req_id before creating a report for a different event',async()=>{
 const s=setup();s.text('今天销售成交1元','r1');await s.app.handle(s.request());s.text('今天销售成交2元','r2');s.setReqId('req-r1');await expect(s.app.handle(s.request())).rejects.toThrow('bot_reply_conflict');expect(s.ledger.list(s.actor)).toHaveLength(1);expect(s.replies).toHaveLength(1);
});
it('serializes conflicting concurrent confirmations before either can add a second business result',async()=>{
 const s=setup();s.text('2026-10-17销售成交1元','r1');const first=await s.app.handle(s.request());s.text('2026-10-18销售成交2元','r2');const second=await s.app.handle(s.request());
 const a=s.ledger.getReport(s.actor,first.result.reportId!)!,b=s.ledger.getReport(s.actor,second.result.reportId!)!;
 s.confirm(a.id,a.hash,'same-event');const left=s.app.handle(s.request());s.confirm(b.id,b.hash,'same-event');const right=s.reopen().handle(s.request());const results=await Promise.allSettled([left,right]);
 expect(results.filter(r=>r.status==='rejected')).toHaveLength(1);expect(s.ledger.list(s.actor).filter(r=>r.state==='confirmed')).toHaveLength(1);
});
it('allows the full 200-character Home already authorized by T1',async()=>{
 const s=setup('web:'+'x'.repeat(196));s.text();const result=await s.app.handle(s.request());expect(result.delivery?.state).toBe('accepted');expect(s.replies).toHaveLength(1);
});
it('competes immediate confirmation and proactive recovery using the same original claim',async()=>{
 const s=setup(),r=s.seed();s.confirm(r.id,r.hash);await Promise.all([s.app.handle(s.request()),s.reopen().recover(s.request(),r.id)]);
 expect(s.replies.length+s.notifications.length).toBe(1);expect(s.ledger.getReport(s.actor,r.id)?.delivery).toMatchObject({state:'accepted',attempt:1});
});
it('records pre-send revocation as blocked, preserving the business and allowing a later authorized recovery',async()=>{
 const s=setup(),r=s.seed();let revoked=false;s.setReadyHook(()=>{if(!revoked){revoked=true;s.grants.change('admin',{accountId:'a',storeId:'b',roles:['manager'],active:false,expectedVersion:1,requestKey:'revoke-late'});}});
 expect((await s.app.recover(s.request(),r.id)).delivery.state).toBe('blocked');expect(s.notifications).toEqual([]);expect(s.ledger.getReport(s.actor,r.id)?.state).toBe('confirmed');
 s.grants.change('admin',{accountId:'a',storeId:'b',roles:['manager'],active:true,expectedVersion:2,requestKey:'restore'});expect((await s.app.recover(s.request(),r.id)).delivery.state).toBe('accepted');expect(s.notifications).toHaveLength(1);
});
it('persists timeout after invocation as unknown even when ACK resolves later',async()=>{
 const s=setup(),r=s.seed();s.confirm(r.id,r.hash);let resolve!:(v:unknown)=>void;s.setInvoke(()=>new Promise(r=>{resolve=r;}));const result=await s.app.handle(s.request());expect(result.reportDelivery?.state).toBe('unknown');resolve({headers:{req_id:'req-confirm-1'},errcode:0});await new Promise<void>(r=>setImmediate(r));
 expect(s.ledger.getReport(s.actor,r.id)?.delivery?.state).toBe('unknown');expect((await s.reopen().recover(s.request(),r.id)).suppressed).toBe(true);expect(s.notifications).toEqual([]);
});
