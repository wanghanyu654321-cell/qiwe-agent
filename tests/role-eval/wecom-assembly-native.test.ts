import {afterEach,expect,it} from 'vitest';
import {DatabaseSync} from 'node:sqlite';
import fs from 'node:fs';import os from 'node:os';import path from 'node:path';
import {createWecomBotAssembly,type WecomBotAssemblyOutcome} from '../../src/role-eval/wecom-bot-assembly.js';
import {createNativeBotIdentityReader} from '../../src/role-eval/native-bot-identity.js';
import {createNativeBotReadPort} from '../../src/role-eval/native-bot-service.js';
import {createNativeBotTasks} from '../../src/role-eval/native-bot-tasks.js';
import {createWecomBotBindingReader} from '../../src/role-eval/wecom-bot-bindings.js';
import {WorkbenchAccessStore} from '../../src/role-eval/workbench-access.js';
import {ManagerStore} from '../../src/role-eval/manager-store.js';
import {BotTaskStore,type BotTaskOwner} from '../../src/role-eval/wecom-bot-task-store.js';
import {offlineBotSdk} from '../fixtures/offline-bot-sdk.js';
const cleanups:(()=>void)[]=[];afterEach(()=>{for(const close of cleanups.splice(0).reverse())close();});
const actor={tenant:'tenant',store:'store-b',workspace:'business:store-b',employeeId:'original-employee',employeeName:'合成美容师'};
const owner:BotTaskOwner={tenantId:'tenant',storeId:'store-b',accountId:'a',workspaceJid:'web:home-a',role:'marketing',corpId:'corp',botId:'bot',memberId:'member-a',bindingVersion:1};
const reference='c'.repeat(64),backend={kind:'native' as const,taskId:'original-task',profileId:'original-profile',workspaceJid:'web:original-role'};
const text=(id:string,content:string)=>({cmd:'aibot_msg_callback',headers:{req_id:id},body:{aibotid:'bot',msgid:id,chattype:'single',from:{userid:'member-a'},msgtype:'text',text:{content}}});
function fixture(){
 const directory=fs.mkdtempSync(path.join(os.tmpdir(),'wecom-native-assembly-'));cleanups.push(()=>fs.rmSync(directory,{recursive:true,force:true}));
 const file=path.join(directory,'original-native-shape.sqlite'),native=new DatabaseSync(file);cleanups.push(()=>native.close());
 native.exec(`CREATE TABLE users(id TEXT PRIMARY KEY,role TEXT,status TEXT,must_change_password INTEGER);
 CREATE TABLE registered_groups(jid TEXT PRIMARY KEY,folder TEXT,created_by TEXT,is_home INTEGER,execution_mode TEXT);
 CREATE TABLE tasks(id TEXT PRIMARY KEY,chat_jid TEXT,group_folder TEXT,execution_type TEXT,execution_mode TEXT,status TEXT,deleted_at TEXT);
 CREATE TABLE profiles(id TEXT PRIMARY KEY,owner_user_id TEXT,status TEXT);
 CREATE TABLE bindings(group_folder TEXT PRIMARY KEY,agent_profile_id TEXT);
 CREATE TABLE runs(id TEXT PRIMARY KEY,body TEXT);
 INSERT INTO users VALUES('a','member','active',0);
 INSERT INTO registered_groups VALUES('web:home-a','home-folder','a',1,'container'),('web:original-role','role-folder','a',0,'container');
 INSERT INTO tasks VALUES('original-task','web:original-role','role-folder','agent','container','active',null);
 INSERT INTO profiles VALUES('original-profile','a','active');
 INSERT INTO bindings VALUES('role-folder','original-profile');`);
 const run={id:'original-run',task_id:'original-task',idempotency_key:'bot-'+reference,trigger_type:'manual',status:'success',result:'已保存岗位结果（合成）',definition_snapshot:{chat_jid:'web:original-role',group_folder:'role-folder',execution_type:'agent',execution_mode:'container',prompt:'private synthetic prompt'}};
 native.prepare('INSERT INTO runs VALUES(?,?)').run(run.id,JSON.stringify(run));
 // These fixture functions reproduce verified original synchronous return shapes;
 // they are not imports of the private Native module or a second runtime.
 const readers={getTaskById:(id:string)=>native.prepare('SELECT * FROM tasks WHERE id=?').get(id),
  getRegisteredGroup:(jid:string)=>{const row=native.prepare('SELECT * FROM registered_groups WHERE jid=?').get(jid);return row?{jid:row.jid,folder:row.folder,created_by:row.created_by,is_home:row.is_home===1,executionMode:row.execution_mode}:undefined;},
  getAgentProfile:(id:string)=>native.prepare('SELECT * FROM profiles WHERE id=?').get(id),
  getWorkspaceAgentProfileBinding:(folder:string)=>native.prepare('SELECT * FROM bindings WHERE group_folder=?').get(folder),
  getTaskRunById:(id:string)=>{const row=native.prepare('SELECT body FROM runs WHERE id=?').get(id);return row?JSON.parse(String(row.body)):undefined;}};
 const port=createNativeBotReadPort({mode:'isolated-synthetic',readers}),adapter=createNativeBotTasks({port});cleanups.push(()=>port.close(),()=>adapter.close());
 const grants=new WorkbenchAccessStore(path.join(directory,'original-grants.sqlite'));cleanups.push(()=>grants.close());
 grants.change('admin',{accountId:'a',storeId:'store-b',roles:['marketing','manager'],active:true,expectedVersion:0,requestKey:'open'});
 const ledgerFile=path.join(directory,'existing-reports.sqlite');let ledger=new ManagerStore(ledgerFile),refs=new BotTaskStore(ledgerFile);cleanups.push(()=>ledger.close(),()=>refs.close());
 const report=ledger.receive(actor,'original-web-report','今天销售250元','2026-10-20');ledger.confirm(actor,report.id,report.hash,report.proposed.items);
 refs.reserve({id:reference,fingerprint:'d'.repeat(64),owner,input:{kind:'native',alias:'weekly'},backend});const claim=refs.claimStart(owner,reference)!;
 refs.finishStart(owner,reference,claim.attempt,{state:'linked',referenceId:run.id,detail:'synthetic_existing_original_reference'});
 const readNative=createNativeBotIdentityReader(file);cleanups.push(()=>readNative.close());
 const readBinding=createWecomBotBindingReader(async()=>[{corpId:'corp',botId:'bot',memberId:'member-a',accountId:'a',version:1,active:true}]);
 const sdk=offlineBotSdk(),outcomes:WecomBotAssemblyOutcome[]=[];
 const options=()=>({mode:'isolated-synthetic' as const,botId:'bot',corpId:'corp',client:sdk.client,identity:{tenantId:'tenant',stores:[{id:'store-b'}],roles:['manager','marketing'] as const,store:grants,readBinding,readNative},
  businesses:[{scope:{tenant:actor.tenant,store:actor.store,workspace:actor.workspace},employees:[{accountId:'a',employeeId:actor.employeeId,employeeName:actor.employeeName}],ledger,tasks:{store:refs,catalog:[{tenantId:'tenant',storeId:'store-b',accountId:'a',homeJid:owner.workspaceJid,role:'marketing' as const,alias:'weekly',...backend}],native:adapter}}],
  sender:{sdk:sdk.sdk,fileSdk:sdk.fileSdk},onOutcome:(result:WecomBotAssemblyOutcome)=>{outcomes.push(result);}});
 let app=createWecomBotAssembly(options());cleanups.push(()=>app.close());
 return {native,port,grants,sdk,report,options,outcomes,get ledger(){return ledger;},get refs(){return refs;},
  async message(id:string,content:string){sdk.frame(text(id,content));await app.idle();return outcomes.at(-1)!;},
  reopen(){app.close();ledger.close();refs.close();ledger=new ManagerStore(ledgerFile);refs=new BotTaskStore(ledgerFile);app=createWecomBotAssembly(options());}};
}
it('routes installed SDK through real read-only identity SQLite to original report and mapped Native run, without executing anything',async()=>{
 const f=fixture();f.sdk.authenticate();
 expect((await f.message('report','查询 '+f.report.id)).result?.result).toMatchObject({status:'confirmed',reportId:f.report.id});
 const result=await f.message('progress','查询任务 内容营销 '+reference);
 expect(result.result?.result).toMatchObject({status:'task',taskId:reference,taskStatus:'success'});
 expect(result.result?.result.reply.body.stream.content).toContain('已保存岗位结果（合成）');expect(JSON.stringify(result)).not.toContain('private synthetic prompt');
 const before=f.native.prepare('SELECT * FROM runs').all();
 expect((await f.message('start','执行任务 内容营销 weekly')).result?.result.taskStatus).toBe('blocked');
 expect((await f.message('cancel','取消任务 内容营销 '+reference)).result?.result.reply.body.stream.content).toContain('取消请求：明确未取消');
 expect(f.refs.get(owner,reference)?.cancellation.state).toBe('blocked');
 expect(f.native.prepare('SELECT * FROM runs').all()).toEqual(before);expect(f.ledger.list(actor)).toHaveLength(1);expect(f.port.enabled).toBe(false);
 f.reopen();f.sdk.authenticate();
 expect((await f.message('reopened','查询任务 内容营销 '+reference)).result?.result.taskStatus).toBe('success');
 expect((await f.message('report-again','查询 '+f.report.id)).result?.result.reportId).toBe(f.report.id);
});
it('respects the same original grant revocation/restoration without changing the original report/run',async()=>{
 const f=fixture();f.sdk.authenticate();
 const before=f.native.prepare('SELECT * FROM runs').all(),original=f.ledger.getReport(actor,f.report.id);
 f.grants.change('admin',{accountId:'a',storeId:'store-b',roles:['manager','marketing'],active:false,expectedVersion:1,requestKey:'revoke'});
 expect((await f.message('denied','查询任务 内容营销 '+reference)).state).toBe('rejected');expect(f.sdk.sent).toEqual([]);
 f.grants.change('admin',{accountId:'a',storeId:'store-b',roles:['manager','marketing'],active:true,expectedVersion:2,requestKey:'restore'});
 expect((await f.message('restored','查询任务 内容营销 '+reference)).result?.result.taskStatus).toBe('success');
 expect(f.native.prepare('SELECT * FROM runs').all()).toEqual(before);expect(f.ledger.getReport(actor,f.report.id)).toEqual(original);
});
