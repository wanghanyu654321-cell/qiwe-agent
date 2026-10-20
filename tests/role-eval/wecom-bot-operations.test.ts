import {afterEach,it,expect} from 'vitest';
import {mkdtempSync,rmSync} from 'node:fs';import {tmpdir} from 'node:os';import {join} from 'node:path';
import AdmZip from 'adm-zip';
import {ManagerStore} from '../../src/role-eval/manager-store.js';
import {ManagerArtifactStore} from '../../src/role-eval/manager-artifacts.js';
import {WorkbenchAccessStore} from '../../src/role-eval/workbench-access.js';
import {createWecomBotContext} from '../../src/role-eval/wecom-bot-context.js';
import {createBotSender,type BotSdkPort,type BotFileSdkPort} from '../../src/role-eval/wecom-bot-sender.js';
import {createBotDelivery} from '../../src/role-eval/wecom-bot-delivery.js';
const cleanup:(()=>void)[]=[];afterEach(()=>{for(const close of cleanup.splice(0).reverse())close();});
function setup(hooks:{upload?:()=>void|Promise<void>}={}){
 const directory=mkdtempSync(join(tmpdir(),'bot-operations-'));cleanup.push(()=>rmSync(directory,{recursive:true,force:true}));
 const ledger=new ManagerStore(join(directory,'reports.sqlite')),grants=new WorkbenchAccessStore(join(directory,'grants.sqlite'));cleanup.push(()=>ledger.close(),()=>grants.close());
 const actor={tenant:'tenant',store:'b',workspace:'web:original-ledger',employeeId:'e',employeeName:'合成美容师'},source={kind:'wecom-bot' as const,corpId:'corp',botId:'bot',memberId:'member-a',accountId:'a',workspaceJid:'web:home-a',storeId:'b',bindingVersion:1};
 for(const id of ['a','b'])grants.change('admin',{accountId:id,storeId:'b',roles:['manager'],active:true,expectedVersion:0,requestKey:'open-'+id});
 let account='a',member='member-a',event=0,frame:unknown;
 const authority=createWecomBotContext({mode:'isolated-synthetic',botId:'bot',corpId:'corp',tenantId:'tenant',stores:[{id:'b'},{id:'c'}],roles:['manager'],store:grants,readSubject:async()=>({botId:'bot',memberId:member}),readBinding:async()=>({corpId:'corp',botId:'bot',memberId:member,accountId:account,active:true,version:1}),readNative:async()=>({user:{id:account,role:'member',status:'active',must_change_password:false},workspaceJid:'web:home-'+account})});cleanup.push(()=>authority.close());
 const replies:string[]=[],uploads:Buffer[]=[],files:{member:string;body:unknown}[]=[];let rejectUpload=false,rejectSend=false;
 const sdk:BotSdkPort={mode:'isolated-synthetic',ready:()=>true,reply:async(f,body)=>{replies.push(body.stream.content);return {headers:{req_id:f.headers.req_id},errcode:0};},sendMessage:async()=>{throw Error('unexpected_markdown_fallback');}};
 sdk.updateTemplateCard=async(f,update)=>{replies.push(update.card.main_title.desc!);return {headers:{req_id:f.headers.req_id},errcode:0};};
 const fileSdk:BotFileSdkPort={mode:'isolated-synthetic',uploadMedia:async b=>{uploads.push(Buffer.from(b));await hooks.upload?.();if(rejectUpload)throw Error('synthetic-upload-failed');return {type:'file',media_id:'file-media'};},sendMessage:async(m,body)=>{files.push({member:m,body});if(rejectSend)throw Error('synthetic-send-unknown');return {headers:{req_id:'file-ack-'+files.length},errcode:0};}};
 const artifacts=new ManagerArtifactStore({mode:'isolated-synthetic',directory:join(directory,'existing-manager-artifacts')});
 const make=()=>{const sender=createBotSender({sdk,fileSdk,timeoutMs:100}),app=createBotDelivery({mode:'isolated-synthetic',authority,ledger,artifacts,scope:{tenant:'tenant',store:'b',workspace:'web:original-ledger'},employees:[{accountId:'a',employeeId:'e',employeeName:'合成美容师'}],readEvent:()=>frame,now:()=>new Date('2026-10-18T01:00:00Z'),sender});cleanup.push(()=>app.close());return app;};
 const app=make(),request=()=>({correlationId:'ops',signal:new AbortController().signal,deadline:performance.now()+2000});
 const text=(content:string,id='message-'+ ++event)=>{frame={cmd:'aibot_msg_callback',headers:{req_id:'req-'+id},body:{aibotid:'bot',msgid:id,chattype:'single',from:{userid:member},msgtype:'text',text:{content}}};};
 const confirm=(id:string,hash:string,eventId='confirm-'+ ++event)=>{frame={cmd:'aibot_event_callback',headers:{req_id:'req-'+eventId},body:{aibotid:'bot',msgid:eventId,chattype:'single',from:{userid:member},msgtype:'event',event:{eventtype:'template_card_event',task_id:'report-'+id+'-'+'c'.repeat(32),event_key:'confirm:'+hash}}};};
 const seed=(text='今天销售成交250元',id='sale')=>{const r=ledger.receiveBot(actor,id,text,'2026-10-18',{...source,messageId:id});return ledger.confirm(actor,r.id,r.hash,r.proposed.items);};
 return {directory,ledger,grants,authority,actor,app,make,artifacts,replies,uploads,files,request,text,confirm,seed,owner:{accountId:'a',actor},switchMember:()=>{account='b';member='member-b';},failUpload:()=>{rejectUpload=true;},failSend:()=>{rejectSend=true;}};
}
it('prepares an explicit correction and only replaces the old entry after the existing confirmation',async()=>{
 const s=setup(),original=s.seed();s.text(`更正 ${original.id} 1 200元`);const pending=await s.app.handle(s.request());expect(pending.result.status).toBe('pending');
 const correction=s.ledger.getReport(s.actor,pending.result.reportId!)!;expect(correction.proposed.items[0]).toMatchObject({amountCents:20000,supersedes:original.entries[0]!.id});expect(pending.result.reply.body.stream.content).toContain('250.00元');expect(s.ledger.summary(s.actor,'2026-10-18','month').salesCents).toBe(25000);
 s.confirm(correction.id,correction.hash);expect((await s.app.handle(s.request())).result.status).toBe('confirmed');expect(s.ledger.summary(s.actor,'2026-10-18','month').salesCents).toBe(20000);
 s.text('查询 '+original.id);expect((await s.app.handle(s.request())).result.reply.body.stream.content).toContain('已更正');
});
it('returns and reopens an immutable summary with the original sales metric and percentage',async()=>{
 const s=setup();s.seed('本月目标1000元','target');s.seed();s.text('经营汇总 2026-10-18 本月');const first=await s.app.handle(s.request());expect(first.result.status).toBe('summary');expect(first.result.reply.body.stream.content).toContain('25.00%');expect(first.result.reply.body.stream.content).toContain('250.00元');
 const id=first.result.snapshotId!;s.text('查询汇总 '+id);const query=await s.make().handle(s.request());expect(query.result.snapshotId).toBe(id);expect(query.result.reply.body.stream.content).toContain('250.00元');
});
it('exports a real Excel for the same snapshot and sends it as a file to the authorized member',async()=>{
 const s=setup();s.seed('本月目标1000元','target');s.seed();s.text('经营汇总 2026-10-18 本月');const summary=await s.app.handle(s.request()),id=summary.result.snapshotId!;
 s.text('导出Excel '+id);const exported=await s.app.handle(s.request());expect(exported.result.status).toBe('file');expect(exported.delivery?.state).toBe('accepted');expect(s.files).toEqual([{member:'member-a',body:{msgtype:'file',chat_type:1,file:{media_id:'file-media'}}}]);
 const zip=new AdmZip(s.uploads[0]!);expect(zip.readAsText('xl/worksheets/sheet1.xml')).toContain(id);expect(zip.readAsText('xl/worksheets/sheet1.xml')).toContain('<v>0.25</v>');expect(zip.readAsText('xl/worksheets/sheet2.xml')).toContain('sale');
 await s.make().handle(s.request());expect(s.files).toHaveLength(1);s.text('查询文件 '+id);expect((await s.make().handle(s.request())).delivery?.state).toBe('accepted');expect(s.files).toHaveLength(2);expect(s.uploads[1]).toEqual(s.uploads[0]);
});
it('rejects stale exports while preserving the original saved summary',async()=>{
 const s=setup(),r=s.seed();s.text('经营汇总 2026-10-18 本月');const old=await s.app.handle(s.request()),id=old.result.snapshotId!;
 s.text(`更正 ${r.id} 1 200元`);const changed=await s.app.handle(s.request()),pending=s.ledger.getReport(s.actor,changed.result.reportId!)!;s.confirm(pending.id,pending.hash);await s.app.handle(s.request());
 s.text('导出Excel '+id);expect((await s.app.handle(s.request())).result.status).toBe('conflict');expect(s.files).toEqual([]);s.text('查询汇总 '+id);expect((await s.app.handle(s.request())).result.reply.body.stream.content).toContain('250.00元');
});
it('never reuploads or resends a file with unknown message outcome on a duplicate event',async()=>{
 const s=setup();s.seed();s.text('经营汇总 2026-10-18 本月');const id=(await s.app.handle(s.request())).result.snapshotId!;s.failSend();s.text('导出Excel '+id);expect((await s.app.handle(s.request())).delivery?.state).toBe('unknown');await s.make().handle(s.request());expect(s.uploads).toHaveLength(1);expect(s.files).toHaveLength(1);
});
it('returns the persisted file outcome on replay after the ledger changes',async()=>{
 const s=setup();s.seed();s.text('经营汇总 2026-10-18 本月');const id=(await s.app.handle(s.request())).result.snapshotId!;s.failSend();s.text('导出Excel '+id,'export-replay');expect((await s.app.handle(s.request())).delivery?.state).toBe('unknown');
 s.seed('本月目标1000元','later-target');s.text('导出Excel '+id,'export-replay');const replay=await s.make().handle(s.request());expect(replay.delivery?.state).toBe('unknown');expect(replay.suppressed).toBe(true);expect(s.files).toHaveLength(1);expect(s.uploads).toHaveLength(1);
});
it('keeps upload-only failure blocked without claiming file acceptance',async()=>{
 const s=setup();s.seed();s.text('经营汇总 2026-10-18 本月');const id=(await s.app.handle(s.request())).result.snapshotId!;s.failUpload();s.text('导出Excel '+id);expect((await s.app.handle(s.request())).delivery?.state).toBe('blocked');expect(s.files).toEqual([]);expect(s.ledger.summary(s.actor,'2026-10-18','month').salesCents).toBe(25000);
});
it('lets the employee look up an unknown file delivery in the saved summary without resending',async()=>{
 const s=setup();s.seed();s.text('经营汇总 2026-10-18 本月');const id=(await s.app.handle(s.request())).result.snapshotId!;s.failSend();s.text('导出Excel '+id);expect((await s.app.handle(s.request())).delivery?.state).toBe('unknown');s.text('查询汇总 '+id);
 const query=await s.make().handle(s.request());expect(query.result.reply.body.stream.content).toContain('文件投递：');expect(query.result.reply.body.stream.content).toContain('结果未知');expect(s.files).toHaveLength(1);expect(s.uploads).toHaveLength(1);
});
it('does not turn malformed operations into new reports or disclose another account snapshot',async()=>{
 const s=setup();s.seed();const count=s.ledger.list(s.actor).length;s.text('更正 bad 1 10元');expect((await s.app.handle(s.request())).result.status).toBe('needs-input');expect(s.ledger.list(s.actor)).toHaveLength(count);
 s.text('经营汇总 2026-10-18 本月');const id=(await s.app.handle(s.request())).result.snapshotId!;s.switchMember();s.text('查询文件 '+id);await expect(s.app.handle(s.request())).rejects.toThrow('access_denied');expect(s.files).toEqual([]);
});
it('rechecks revocation after upload and never sends the file',async()=>{
 const s=setup({upload:()=>{s.grants.change('admin',{accountId:'a',storeId:'b',roles:[],active:false,expectedVersion:1,requestKey:'revoke'});}});s.seed();s.text('经营汇总 2026-10-18 本月');const id=(await s.app.handle(s.request())).result.snapshotId!;s.text('导出Excel '+id);
 expect((await s.app.handle(s.request())).delivery?.state).toBe('blocked');expect(s.uploads).toHaveLength(1);expect(s.files).toEqual([]);
});
it('rechecks the same ledger revision after upload before sending a newly exported file',async()=>{
 const s=setup({upload:()=>{s.seed('本月目标1000元','target-during-upload');}});s.seed();s.text('经营汇总 2026-10-18 本月');const id=(await s.app.handle(s.request())).result.snapshotId!;s.text('导出Excel '+id);
 expect((await s.app.handle(s.request())).delivery?.state).toBe('blocked');expect(s.files).toEqual([]);expect(s.artifacts.artifact(s.owner,id)).toBeDefined();
});
it('returns an explicitly requested historical file after a ledger revision without rewriting its bytes',async()=>{
 const s=setup();s.seed();s.text('经营汇总 2026-10-18 本月');const id=(await s.app.handle(s.request())).result.snapshotId!;s.text('导出Excel '+id);await s.app.handle(s.request());s.seed('本月目标1000元','new-target');s.text('查询文件 '+id);
 expect((await s.make().handle(s.request())).delivery?.state).toBe('accepted');expect(s.files).toHaveLength(2);expect(s.uploads[1]).toEqual(s.uploads[0]);
});
it('claims one file send when two authorized consumers race the same event',async()=>{
 const s=setup();s.seed();s.text('经营汇总 2026-10-18 本月');const id=(await s.app.handle(s.request())).result.snapshotId!;s.text('导出Excel '+id);
 const results=await Promise.all([s.app.handle(s.request()),s.make().handle(s.request())]);expect(results.filter(r=>r.suppressed)).toHaveLength(1);expect(s.files).toHaveLength(1);expect(s.uploads).toHaveLength(1);
});
