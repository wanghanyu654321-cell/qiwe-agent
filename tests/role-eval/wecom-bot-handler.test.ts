import {afterEach,expect,it} from 'vitest';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {ManagerStore} from '../../src/role-eval/manager-store.js';
import {WorkbenchAccessStore} from '../../src/role-eval/workbench-access.js';
import {createWecomBotContext} from '../../src/role-eval/wecom-bot-context.js';
import {createBotReportHandler} from '../../src/role-eval/wecom-bot-handler.js';
const cleanups:(()=>void)[]=[];afterEach(()=>{for(const close of cleanups.splice(0).reverse())close();});
function setup(){
 const dir=mkdtempSync(join(tmpdir(),'bot-report-flow-'));cleanups.push(()=>rmSync(dir,{recursive:true,force:true}));
 const ledger=new ManagerStore(join(dir,'existing.sqlite')),grants=new WorkbenchAccessStore(join(dir,'grants.sqlite'));
 cleanups.push(()=>ledger.close(),()=>grants.close());
 const scope={tenant:'tenant',store:'b',workspace:'web:original-b'};
 const people=[{accountId:'a',employeeId:'original-a',employeeName:'合成美容师甲'},{accountId:'b',employeeId:'original-b',employeeName:'合成美容师乙'}];
 let member='member-a',account='a',time=new Date('2026-10-17T01:00:00Z'),nativeStatus='active',reads=0,afterRead=(_n:number)=>{};
 const open=(id:string,store='b',roles=['manager'] as ('manager'|'training')[])=>grants.change('admin',{accountId:id,storeId:store,roles,active:true,expectedVersion:grants.get(id)?.version??0,requestKey:'open-'+id+'-'+(grants.get(id)?.version??0)});
 open('a');open('b');
 const authority=createWecomBotContext({mode:'isolated-synthetic',botId:'bot',corpId:'corp',tenantId:'tenant',stores:[{id:'b'},{id:'c'}],roles:['manager','training'],store:grants,
 readSubject:async()=>({botId:'bot',memberId:member}),readBinding:async()=>({corpId:'corp',botId:'bot',memberId:member,accountId:account,version:1,active:true}),readNative:async id=>{afterRead(++reads);return {user:{id,role:'member',status:nativeStatus,must_change_password:false},workspaceJid:'web:home-'+id};}});
 cleanups.push(()=>authority.close());
 let frame:unknown;
 const text=(content='今天销售成交123.45元',msgid='text-1',who=member)=>frame={cmd:'aibot_msg_callback',headers:{req_id:'req-'+msgid},body:{aibotid:'bot',msgid,chattype:'single',from:{userid:who},msgtype:'text',text:{content}}};
 const card=(id:string,hash:string)=>frame={cmd:'aibot_event_callback',headers:{req_id:'req-card'},body:{aibotid:'bot',msgid:'card-1',chattype:'single',from:{userid:member},msgtype:'event',event:{eventtype:'template_card_event',task_id:'report-'+id+'-'+'c'.repeat(32),event_key:'confirm:'+hash,accountId:'admin',amountCents:1}}};
 const handler=createBotReportHandler({mode:'isolated-synthetic',authority,ledger,scope,employees:people,readEvent:()=>frame,now:()=>time});
 const request=()=>({correlationId:'task',signal:new AbortController().signal,deadline:performance.now()+1000});
 const actor=(index=0)=>({...scope,employeeId:people[index]!.employeeId,employeeName:people[index]!.employeeName});
 return {ledger,grants,authority,handler,request,text,card,actor,scope,people,open,setFrame:(v:unknown)=>{frame=v;},getFrame:()=>frame,setTime:(v:Date)=>{time=v;},switchMember:()=>{member='member-b';account='b';},disable:()=>{nativeStatus='disabled';},enable:()=>{nativeStatus='active';},onNativeRead:(fn:(n:number)=>void)=>{afterRead=fn;}};
}
it('reports, confirms server amounts and queries the same persistent report without Web',async()=>{
 const s=setup();s.text();const pending=await s.handler.handle(s.request());
 expect(pending.status).toBe('pending');expect(pending.reply.body.template_card?.task_id).toContain('report-'+pending.reportId+'-');
 const report=s.ledger.getReport(s.actor(),pending.reportId!)!;expect(report.proposed.items[0]?.amountCents).toBe(12345);expect(report.state).toBe('pending');
 s.card(report.id,report.hash);const confirmed=await s.handler.handle(s.request());expect(confirmed.status).toBe('confirmed');
 expect(s.ledger.getReport(s.actor(),report.id)?.entries[0]?.amountCents).toBe(12345);expect(s.ledger.getReport(s.actor(),report.id)?.delivery?.state).toBe('prepared');
 s.text('查询 '+report.id,'query');const query=await s.handler.handle(s.request());expect(query).toMatchObject({status:'confirmed',reportId:report.id});expect(query.reply.body.stream.content).toContain('123.45元');expect(query.reply.body.template_card).toBeUndefined();expect(query.reply.body.stream.content).not.toMatch(/https?:/);
});
it('replays text and confirmation without duplicating totals or consuming notification intent',async()=>{
 const s=setup();s.text();const first=await s.handler.handle(s.request());s.setTime(new Date('2026-10-18T01:00:00Z'));expect((await s.handler.handle(s.request())).reportId).toBe(first.reportId);
 const r=s.ledger.getReport(s.actor(),first.reportId!)!;s.card(r.id,r.hash);await s.handler.handle(s.request());await s.handler.handle(s.request());
 expect(s.ledger.summary(s.actor(),'2026-10-17','month').salesCents).toBe(12345);expect(s.ledger.list(s.actor())).toHaveLength(1);expect(s.ledger.getReport(s.actor(),r.id)?.delivery).toMatchObject({state:'prepared',attempt:0,msgid:null});
});
it('keeps ambiguous input pending and offers no confirmation button',async()=>{
 const s=setup();s.text('销售成交100元');const result=await s.handler.handle(s.request());expect(result.status).toBe('needs-input');expect(result.reply.body.template_card).toBeUndefined();
 expect(result.reply.body.stream.content).toContain('统计期间');const r=s.ledger.getReport(s.actor(),result.reportId!)!;s.card(r.id,r.hash);expect((await s.handler.handle(s.request())).status).toBe('needs-input');expect(s.ledger.summary(s.actor(),'2026-10-17','month').salesCents).toBeNull();
});
it('refuses stale card hashes and never trusts supplied amounts',async()=>{
 const s=setup();s.text();const p=await s.handler.handle(s.request());s.card(p.reportId!,'f'.repeat(64));expect((await s.handler.handle(s.request())).status).toBe('conflict');expect(s.ledger.getReport(s.actor(),p.reportId!)?.state).toBe('pending');
});
it('does not expose or confirm another employees report',async()=>{
 const s=setup();s.text();const p=await s.handler.handle(s.request());const r=s.ledger.getReport(s.actor(),p.reportId!)!;s.switchMember();
 s.text('查询 '+r.id,'query-b');expect((await s.handler.handle(s.request())).status).toBe('not-found');s.card(r.id,r.hash);expect((await s.handler.handle(s.request())).status).toBe('not-found');expect(s.ledger.getReport(s.actor(),r.id)?.state).toBe('pending');
});
it('rejects event member forgery and store moves before ledger access',async()=>{
 const s=setup();s.text(undefined,undefined,'member-b');await expect(s.handler.handle(s.request())).rejects.toThrow('access_denied');
 s.open('a','c');s.text();await expect(s.handler.handle(s.request())).rejects.toThrow('access_denied');expect(s.ledger.list(s.actor())).toEqual([]);
});
it('rejects missing manager grant, Native disable and expired or cancelled requests',async()=>{
 const s=setup();s.text();s.open('a','b',['training']);await expect(s.handler.handle(s.request())).rejects.toThrow('access_denied');s.open('a');s.disable();await expect(s.handler.handle(s.request())).rejects.toThrow('access_denied');
 const t=setup();t.text();await expect(t.handler.handle({...t.request(),deadline:performance.now()-1})).rejects.toThrow('authority_timeout');await expect(t.handler.handle({...t.request(),signal:AbortSignal.abort()})).rejects.toThrow('authority_cancelled');expect(t.ledger.list(t.actor())).toEqual([]);
});
it('does not invoke the expensive whole-store listing for single report query',async()=>{
 const s=setup();s.text();const p=await s.handler.handle(s.request());s.ledger.list=()=>{throw Error('should_not_list');};s.text('查询 '+p.reportId,'query');expect((await s.handler.handle(s.request())).reportId).toBe(p.reportId);
});
it('rejects runtime mode and duplicate original employee mappings',()=>{
 const s=setup();const options={mode:'isolated-synthetic' as const,authority:s.authority,ledger:s.ledger,scope:s.scope,employees:[s.people[0]!,{...s.people[0]!,accountId:'b'}],readEvent:()=>null};expect(()=>createBotReportHandler(options)).toThrow('invalid_report_catalog');
 expect(()=>createBotReportHandler({...options,mode:'production' as 'isolated-synthetic'})).toThrow('invalid_report_catalog');
});
it('retains a committed result if authority changes before reply, allowing a later query',async()=>{
 const s=setup();s.text();const p=await s.handler.handle(s.request());const r=s.ledger.getReport(s.actor(),p.reportId!)!;s.card(r.id,r.hash);
 // Each handle reads Native twice to authorize, once before work, once before returning.
 s.onNativeRead(n=>{if(n===8)s.disable();});await expect(s.handler.handle(s.request())).rejects.toThrow('access_changed');
 expect(s.ledger.getReport(s.actor(),r.id)).toMatchObject({state:'confirmed',delivery:{state:'prepared',attempt:0}});
 s.enable();s.text('查询 '+r.id,'recovery');expect((await s.handler.handle(s.request())).status).toBe('confirmed');expect(s.ledger.list(s.actor())).toHaveLength(1);
});
it('observes revocation after initial reads before the business lock',async()=>{
 const s=setup();s.text();s.onNativeRead(n=>{if(n===3)s.grants.change('admin',{accountId:'a',storeId:'b',roles:['manager'],active:false,expectedVersion:1,requestKey:'revoke'});});
 await expect(s.handler.handle(s.request())).rejects.toThrow('access_changed');expect(s.ledger.list(s.actor())).toEqual([]);
});
it('does not expose a historical report owned by a different account mapped to the same original employee',async()=>{
 const s=setup();const actor=s.actor();const r=s.ledger.receiveBot(actor,'old','今天销售成交1元','2026-10-17',{kind:'wecom-bot',corpId:'corp',botId:'bot',memberId:'old-member',messageId:'old',accountId:'old-account',workspaceJid:'web:old',storeId:'b',bindingVersion:1});
 s.text('查询 '+r.id);expect((await s.handler.handle(s.request())).status).toBe('not-found');s.card(r.id,r.hash);expect((await s.handler.handle(s.request())).status).toBe('not-found');expect(s.ledger.getReport(actor,r.id)?.state).toBe('pending');
});
it('uses Shanghai business date and treats a changed source payload as a conflict',async()=>{
 const s=setup();s.setTime(new Date('2026-10-17T16:01:00Z'));s.text();const p=await s.handler.handle(s.request());expect(s.ledger.getReport(s.actor(),p.reportId!)?.date).toBe('2026-10-18');
 s.text('今天销售成交9元');expect((await s.handler.handle(s.request())).status).toBe('conflict');expect(s.ledger.list(s.actor())).toHaveLength(1);
});
it('rejects mismatched corporate identity, group messages and closed context without ledger writes',async()=>{
 const s=setup();s.text();const f=s.getFrame() as {body:{from:object;chattype:string}};Object.assign(f.body.from,{corpid:'wrong'});await expect(s.handler.handle(s.request())).rejects.toThrow('access_denied');
 s.text();(s.getFrame() as typeof f).body.chattype='group';await expect(s.handler.handle(s.request())).rejects.toThrow('unsupported_event');s.text();s.authority.close();await expect(s.handler.handle(s.request())).rejects.toThrow('context_closed');expect(s.ledger.list(s.actor())).toEqual([]);
});
it('rejects catalog mutation and does not persist malformed lookup commands',async()=>{
 const s=setup();s.scope.store='c';s.people[0]!.employeeId='other';s.text('查询 bad');expect((await s.handler.handle(s.request())).status).toBe('needs-input');s.text();const p=await s.handler.handle(s.request());expect(s.ledger.getReport({tenant:'tenant',store:'b',workspace:'web:original-b',employeeId:'original-a',employeeName:'合成员工'},p.reportId!)?.actor.employeeId).toBe('original-a');
});
it('uses official task_id characters and separate card IDs for different query events',async()=>{
 const s=setup();s.text();const first=await s.handler.handle(s.request());const task=first.reply.body.template_card!.task_id;
 expect(task).toMatch(/^[A-Za-z0-9_@-]{1,128}$/);expect((await s.handler.handle(s.request())).reply.body.template_card!.task_id).toBe(task);
 s.text('查询 '+first.reportId,'new-query');const next=await s.handler.handle(s.request());expect(next.reply.body.template_card!.task_id).not.toBe(task);expect(next.reply.body.template_card!.task_id).toContain(first.reportId);
});
it('returns the exact original integer cents even near the safe integer limit',async()=>{
 const s=setup();s.text('今天销售成交90071992547409.90元');const result=await s.handler.handle(s.request());
 expect(s.ledger.getReport(s.actor(),result.reportId!)?.proposed.items[0]?.amountCents).toBe(9007199254740990);
 expect(result.reply.body.stream.content).toContain('90071992547409.90元');
});
