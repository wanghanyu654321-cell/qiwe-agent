import {expect,it} from 'vitest';
import {DatabaseSync} from 'node:sqlite';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {ManagerStore,type StaffReportSource} from '../../src/role-eval/manager-store.js';
import {ManagerArtifactStore} from '../../src/role-eval/manager-artifacts.js';
import {WorkbenchAccessStore} from '../../src/role-eval/workbench-access.js';
import {createWorkbenchOpening,type WorkbenchTemplate} from '../../src/role-eval/workbench-opening.js';
import {createNativeBotIdentityReader} from '../../src/role-eval/native-bot-identity.js';
import {createWecomBotContext} from '../../src/role-eval/wecom-bot-context.js';
import {createBotDelivery} from '../../src/role-eval/wecom-bot-delivery.js';
import {createBotSender,type BotSdkPort,type BotFileSdkPort} from '../../src/role-eval/wecom-bot-sender.js';

// The public repository contains the opening HTTP handler, but no original
// manager HTTP/page routes. Business writes below call the original service.
const template:WorkbenchTemplate={key:'manager',name:'经营岗位',skills:['shared-manager'],payload:{name:'共享经营模板'}};
function fixture(){
 const directory=mkdtempSync(join(tmpdir(),'web-bot-compat-')),nativeFile=join(directory,'native.sqlite'),ledgerFile=join(directory,'reports.sqlite');
 const nativeDb=new DatabaseSync(nativeFile);
 nativeDb.exec(`CREATE TABLE users(id TEXT PRIMARY KEY,role TEXT,status TEXT,must_change_password INTEGER);
 CREATE TABLE registered_groups(jid TEXT PRIMARY KEY,created_by TEXT,is_home INTEGER,execution_mode TEXT);
 INSERT INTO users VALUES('admin','admin','active',0),('employee','member','active',0);
 INSERT INTO registered_groups VALUES('web:home-employee','employee',1,'container');`);
 const grants=new WorkbenchAccessStore(join(directory,'access.sqlite'));
 const originalProfiles=[{id:'personal-existing',owner_user_id:'employee',name:'本人原岗位',private:'synthetic original history'}];
 const calls={handle:0,authenticate:0,employees:0,groups:0,skills:0,profiles:0,list:0,create:0};
 let webEnabled=true,disabledWebAttempts=0,frame:unknown,eventNumber=0;
 const webCall=(key:keyof typeof calls)=>{if(!webEnabled){disabledWebAttempts++;throw Error('web_fixture_disabled');}calls[key]++;};
 const user=(id:string)=>{const row=nativeDb.prepare('SELECT * FROM users WHERE id=?').get(id);return row?{...row,must_change_password:row.must_change_password===1}:null;};
 const opening=createWorkbenchOpening({origin:'https://frontagent.cn',tenantId:'synthetic-web-compat',stores:[{id:'b',name:'合成B店'},{id:'c',name:'合成C店'}],templates:[template],store:grants,journalDirectory:join(directory,'journal'),native:{
  authenticate:async cookie=>{webCall('authenticate');return user(cookie);},
  employees:async()=>{webCall('employees');return [user('employee')];},
  groups:async cookie=>{webCall('groups');const home=nativeDb.prepare('SELECT jid FROM registered_groups WHERE created_by=? AND is_home=1').get(cookie);return {groups:home?{[String(home.jid)]:{is_my_home:true}}:{}};},
  skills:async()=>{webCall('skills');return ['shared-manager'];},
  profiles:()=>{webCall('profiles');return {list:async()=>{webCall('list');return structuredClone(originalProfiles);},create:async()=>{webCall('create');throw Error('unexpected_profile_creation');}};}
 }});
 const request=async(route:string,cookie:string,body?:unknown)=>{webCall('handle');return opening.handle(new Request('https://frontagent.cn/api/local-product/access'+route,{method:body===undefined?'GET':'POST',headers:{cookie,origin:'https://frontagent.cn'},...(body===undefined?{}:{body:JSON.stringify(body)})}));};
 const grant=async(expectedVersion:number,requestKey:string,active=true,storeId='b')=>{
  const response=await request('','admin',{accountId:'employee',storeId,roles:['manager'],active,expectedVersion,requestKey});
  expect(response.status).toBe(200);expect(await response.json()).toMatchObject({grant:{accountId:'employee',storeId,roles:['manager'],active,version:expectedVersion+1},modelCalls:0});
 };
 const actor={tenant:'synthetic-web-compat',store:'b',workspace:'web:original-ledger',employeeId:'original-employee',employeeName:'合成美容师'};
 const nativeReader=createNativeBotIdentityReader(nativeFile);
 // These trusted binding records are independent of the Web cookie and event.
 const subject=Object.freeze({botId:'bot',memberId:'member-employee'}),binding=Object.freeze({...subject,corpId:'corp',accountId:'employee',active:true,version:1});
 const authority=createWecomBotContext({mode:'isolated-synthetic',botId:'bot',corpId:'corp',tenantId:actor.tenant,stores:[{id:'b'},{id:'c'}],roles:['manager'],store:grants,readSubject:async()=>({...subject}),readBinding:async trusted=>{expect(trusted).toEqual(subject);return {...binding};},readNative:nativeReader});
 const replies:string[]=[],uploads:Buffer[]=[],files:string[]=[];
 const sdk:BotSdkPort={mode:'isolated-synthetic',ready:()=>true,reply:async(f,body)=>{replies.push(body.stream.content);return {headers:{req_id:f.headers.req_id},errcode:0};},sendMessage:async()=>{throw Error('unexpected_proactive_message');}};
 const fileSdk:BotFileSdkPort={mode:'isolated-synthetic',uploadMedia:async bytes=>{uploads.push(Buffer.from(bytes));return {type:'file',media_id:'synthetic-file'};},sendMessage:async member=>{files.push(member);return {headers:{req_id:'file-'+files.length},errcode:0};}};
 let ledger=new ManagerStore(ledgerFile),artifacts=new ManagerArtifactStore({mode:'isolated-synthetic',directory:join(directory,'artifacts')});
 sdk.updateTemplateCard=async(f,update)=>{replies.push(update.card.main_title.desc!);return {headers:{req_id:f.headers.req_id},errcode:0};};
 const make=()=>createBotDelivery({mode:'isolated-synthetic',authority,ledger,artifacts,scope:{tenant:actor.tenant,store:actor.store,workspace:actor.workspace},employees:[{accountId:'employee',employeeId:actor.employeeId,employeeName:actor.employeeName}],readEvent:()=>frame,now:()=>new Date('2026-10-20T01:00:00Z'),sender:createBotSender({sdk,fileSdk,timeoutMs:100})});
 let bot=make();
 const budget=()=>({signal:new AbortController().signal,deadline:performance.now()+3000,correlationId:'web-compat'});
 const text=(content:string)=>{const id='text-'+ ++eventNumber;frame={cmd:'aibot_msg_callback',headers:{req_id:'req-'+id},body:{aibotid:'bot',msgid:id,chattype:'single',from:{userid:subject.memberId},msgtype:'text',text:{content}}};return bot.handle(budget());};
 const confirm=(id:string,hash:string)=>{const eventId='confirm-'+ ++eventNumber;frame={cmd:'aibot_event_callback',headers:{req_id:'req-'+eventId},body:{aibotid:'bot',msgid:eventId,chattype:'single',from:{userid:subject.memberId},msgtype:'event',event:{eventtype:'template_card_event',task_id:'report-'+id+'-'+'a'.repeat(32),event_key:'confirm:'+hash}}};return bot.handle(budget());};
 return {directory,actor,grants,opening,request,grant,originalProfiles,calls,replies,uploads,files,text,confirm,budget,authority,nativeReader,
  get ledger(){return ledger;},get artifacts(){return artifacts;},
  web:(enabled:boolean)=>{webEnabled=enabled;},disabledAttempts:()=>disabledWebAttempts,
  storedFacts:()=>{const db=new DatabaseSync(ledgerFile,{readOnly:true});try{return {reports:db.prepare('SELECT * FROM employee_reports ORDER BY id').all(),replies:db.prepare('SELECT * FROM bot_reply_intents ORDER BY id').all()};}finally{db.close();}},
  reopen:()=>{bot.close();ledger.close();ledger=new ManagerStore(ledgerFile);artifacts=new ManagerArtifactStore({mode:'isolated-synthetic',directory:join(directory,'artifacts')});bot=make();},
  close:()=>{bot.close();ledger.close();authority.close();nativeReader.close();grants.close();nativeDb.close();rmSync(directory,{recursive:true,force:true});}
 };
}

it.each(['absent','legacy-record'] as const)('shares original Web business facts with Bot and survives disabled Web (%s source)',async sourceKind=>{
 const s=fixture();try{
  const profilesBefore=structuredClone(s.originalProfiles);
  expect((await s.request('','admin')).status).toBe(200);
  await s.grant(0,'web-open');
  const self=await s.request('/self','employee');expect(self.status).toBe(200);
  const identity=(await self.json()).identity;expect(identity).toEqual({accountId:'employee',workspaceJid:'web:home-employee',tenantId:s.actor.tenant,storeId:'b',grantVersion:1});
  expect(await s.nativeReader('employee',s.budget())).toMatchObject({user:{id:identity.accountId,status:'active'},workspaceJid:identity.workspaceJid});
  const context=await s.opening.authorize('employee');
  const legacySource:StaffReportSource|undefined=sourceKind==='absent'?undefined:{kind:'wecom-employee',corpId:'corp',agentId:1001,memberId:'legacy-member',messageId:'legacy-sale',createTime:1792458000,accountId:'employee',workspaceJid:'web:home-employee',storeId:'b',bindingVersion:1};
  await s.opening.assertCurrent('employee',context);
  const pending=s.grants.withCurrent(context.grant,()=>s.ledger.receive(s.actor,'web-sale','2026-10-20销售成交250元','2026-10-20',legacySource));
  const original=s.grants.withCurrent(context.grant,()=>s.ledger.confirm(s.actor,pending.id,pending.hash,pending.proposed.items));
  expect(s.ledger.receive(s.actor,'web-sale',original.text,original.date,legacySource).id).toBe(original.id);
  expect(s.ledger.confirm(s.actor,original.id,original.hash,original.proposed.items)).toEqual(original);
  expect(s.ledger.list(s.actor)).toHaveLength(1);
  expect(original.source).toEqual(legacySource);expect(original.botSource).toBeUndefined();
  const query=await s.text('查询 '+original.id);expect(query.result.reportId).toBe(original.id);expect(query.result.reply.body.stream.content).toContain('250.00元');
  const correctionReply=await s.text(`更正 ${original.id} 1 200元`),correction=s.ledger.getReport(s.actor,correctionReply.result.reportId!)!;
  expect(correctionReply.result.status).toBe('pending');expect(correction.correction).toEqual({reportId:original.id,entryId:original.entries[0]!.id,previousAmountCents:25000});
  expect(s.ledger.summary(s.actor,'2026-10-20','month').salesCents).toBe(25000);
  expect((await s.confirm(correction.id,correction.hash)).result.status).toBe('confirmed');
  await s.confirm(correction.id,correction.hash);
  const corrected=s.ledger.getReport(s.actor,correction.id)!;
  expect(corrected).toMatchObject({state:'confirmed',botSource:{kind:'wecom-bot',accountId:'employee',workspaceJid:identity.workspaceJid},delivery:{state:'accepted',attempt:1}});
  expect(s.ledger.getReport(s.actor,original.id)).toEqual(original);
  const businessSummary=s.ledger.summary(s.actor,'2026-10-20','month');expect(businessSummary.salesCents).toBe(20000);expect(businessSummary.entries).toHaveLength(1);expect(s.ledger.list(s.actor)).toHaveLength(2);
  const summary=await s.text('经营汇总 2026-10-20 本月'),snapshotId=summary.result.snapshotId!;
  expect(snapshotId).toBe(businessSummary.snapshotHash);expect(summary.result.reply.body.stream.content).toContain('200.00元');
  expect((await s.text('导出Excel '+snapshotId)).delivery?.state).toBe('accepted');
  const bytes=Buffer.from(s.uploads[0]!);expect(bytes.subarray(0,2).toString()).toBe('PK');expect(s.files).toEqual(['member-employee']);

  s.web(false);const stoppedCalls={...s.calls};s.reopen();
  expect((await s.text('查询 '+original.id)).result).toMatchObject({status:'confirmed',reportId:original.id});
  expect((await s.text('查询 '+original.id)).result.reply.body.stream.content).toContain('已更正');
  expect((await s.text('查询 '+correction.id)).result.reply.body.stream.content).toContain('200.00元');
  expect((await s.text('查询汇总 '+snapshotId)).result.snapshotId).toBe(snapshotId);
  expect((await s.text('查询文件 '+snapshotId)).delivery?.state).toBe('accepted');
  expect(s.uploads).toHaveLength(2);expect(s.uploads[1]).toEqual(bytes);expect(s.files).toEqual(['member-employee','member-employee']);
  expect(s.ledger.summary(s.actor,'2026-10-20','month').snapshotHash).toBe(snapshotId);
  expect(s.calls).toEqual(stoppedCalls);expect(s.disabledAttempts()).toBe(0);

  // Use the original administrator HTTP contract for both revoke and transfer.
  s.web(true);await s.grant(1,'web-revoke',false);expect(s.grants.get('employee')?.version).toBe(2);s.web(false);
  const factsBefore=s.ledger.list(s.actor),storedBefore=s.storedFacts(),sendsBefore=s.replies.length,filesBefore=s.files.length;
  await expect(s.text('今天销售成交999元')).rejects.toThrow('access_denied');
  await expect(s.text('查询 '+original.id)).rejects.toThrow('access_denied');
  expect(s.ledger.list(s.actor)).toEqual(factsBefore);expect(s.replies).toHaveLength(sendsBefore);expect(s.files).toHaveLength(filesBefore);
  expect(s.storedFacts()).toEqual(storedBefore);
  s.web(true);await s.grant(2,'web-transfer',true,'c');s.web(false);
  await expect(s.text('今天销售成交999元')).rejects.toThrow('access_denied');
  await expect(s.text('查询文件 '+snapshotId)).rejects.toThrow('access_denied');
  expect(s.ledger.list(s.actor)).toEqual(factsBefore);expect(s.replies).toHaveLength(sendsBefore);expect(s.files).toHaveLength(filesBefore);
  expect(s.storedFacts()).toEqual(storedBefore);
  s.web(true);await s.grant(3,'web-restore');s.web(false);const finalCalls={...s.calls};
  expect(s.grants.get('employee')?.version).toBe(4);
  expect((await s.text('查询 '+correction.id)).result.reportId).toBe(correction.id);
  expect((await s.text('查询汇总 '+snapshotId)).result.snapshotId).toBe(snapshotId);
  expect((await s.text('查询文件 '+snapshotId)).delivery?.state).toBe('accepted');expect(s.uploads[2]).toEqual(bytes);
  expect(s.ledger.list(s.actor)).toEqual(factsBefore);expect(s.calls).toEqual(finalCalls);expect(s.disabledAttempts()).toBe(0);
  expect(s.originalProfiles).toEqual(profilesBefore);expect(s.calls).toMatchObject({skills:0,profiles:0,list:0,create:0});
 }finally{s.close();}
});
