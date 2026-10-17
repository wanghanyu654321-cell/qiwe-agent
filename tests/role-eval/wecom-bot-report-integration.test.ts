import {expect,it} from 'vitest';
import {DatabaseSync} from 'node:sqlite';
import {mkdtempSync,rmSync,readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {WorkbenchAccessStore} from '../../src/role-eval/workbench-access.js';
import {ManagerStore} from '../../src/role-eval/manager-store.js';
import {createNativeBotIdentityReader} from '../../src/role-eval/native-bot-identity.js';
import {createWecomBotBindingReader} from '../../src/role-eval/wecom-bot-bindings.js';
import {createWecomBotContext} from '../../src/role-eval/wecom-bot-context.js';
import {createBotReportHandler} from '../../src/role-eval/wecom-bot-handler.js';

it('reopens the explicit original ledger, grant and Native databases and queries the same confirmed report',async()=>{
 const directory=mkdtempSync(join(tmpdir(),'bot-three-db-')),nativeFile=join(directory,'native.sqlite');
 const writer=new DatabaseSync(nativeFile);writer.exec(`CREATE TABLE users(id TEXT PRIMARY KEY,role TEXT,status TEXT,must_change_password INTEGER,password_hash TEXT);
 CREATE TABLE registered_groups(jid TEXT PRIMARY KEY,created_by TEXT,is_home INTEGER,execution_mode TEXT);
 INSERT INTO users VALUES('account','member','active',0,'synthetic-private');
 INSERT INTO registered_groups VALUES('web:home','account',1,'container');`);
 const nativeBefore=readFileSync(nativeFile),scope={tenant:'tenant',store:'b',workspace:'web:original-ledger'},employee={accountId:'account',employeeId:'original-beautician',employeeName:'合成美容师'},actor={...scope,...employee};
 let frame:unknown;
 const request=()=>({correlationId:'integration',signal:new AbortController().signal,deadline:performance.now()+3000});
 const text=(content:string,id:string)=>frame={cmd:'aibot_msg_callback',headers:{req_id:'req-'+id},body:{aibotid:'bot',msgid:id,chattype:'single',from:{userid:'member'},msgtype:'text',text:{content}}};
 const open=()=>{
  const grants=new WorkbenchAccessStore(join(directory,'grants.sqlite')),ledger=new ManagerStore(join(directory,'existing-reports.sqlite')),readNative=createNativeBotIdentityReader(nativeFile);
  const authority=createWecomBotContext({mode:'isolated-synthetic',botId:'bot',corpId:'corp',tenantId:scope.tenant,stores:[{id:scope.store}],roles:['manager'],store:grants,readNative,
   readSubject:async()=>({botId:'bot',memberId:'member'}),readBinding:createWecomBotBindingReader(async()=>[{botId:'bot',corpId:'corp',memberId:'member',accountId:employee.accountId,version:1,active:true}])});
  return {grants,ledger,handler:createBotReportHandler({mode:'isolated-synthetic',authority,ledger,scope,employees:[employee],readEvent:()=>frame,now:()=>new Date('2026-10-17T01:00:00Z')}),close(){authority.close();readNative.close();ledger.close();grants.close();}};
 };
 let app=open();
 try{
  app.grants.change('admin',{accountId:'account',storeId:'b',roles:['manager'],active:true,expectedVersion:0,requestKey:'open'});
  const legacy=app.ledger.receive(actor,'original-web-report','昨天销售成交3元','2026-10-17');
  text('今天销售成交88.88元','first');const pending=await app.handler.handle(request()),r=app.ledger.getReport(actor,pending.reportId!)!;
  frame={cmd:'aibot_event_callback',headers:{req_id:'confirmation'},body:{aibotid:'bot',msgid:'card',chattype:'single',from:{userid:'member'},msgtype:'event',event:{eventtype:'template_card_event',task_id:pending.reply.body.template_card!.task_id,event_key:'confirm:'+r.hash}}};
  expect((await app.handler.handle(request())).status).toBe('confirmed');app.close();app=open();
  text('查询 '+r.id,'after-reopen');const result=await app.handler.handle(request());expect(result).toMatchObject({status:'confirmed',reportId:r.id});expect(result.reply.body.stream.content).toContain('88.88元');
  expect(app.ledger.getReport(actor,legacy.id)).toEqual(legacy);expect(app.ledger.getReport(actor,r.id)?.delivery).toMatchObject({state:'prepared',attempt:0});
  expect(readFileSync(nativeFile)).toEqual(nativeBefore);
  writer.exec("UPDATE users SET status='disabled' WHERE id='account'");await expect(app.handler.handle(request())).rejects.toThrow('access_denied');
  writer.exec("UPDATE users SET status='active',must_change_password=1 WHERE id='account'");await expect(app.handler.handle(request())).rejects.toThrow('access_denied');
  writer.exec("UPDATE users SET must_change_password=0 WHERE id='account'; UPDATE registered_groups SET execution_mode='host'");await expect(app.handler.handle(request())).rejects.toThrow('authority_unavailable');
  writer.exec("UPDATE registered_groups SET execution_mode='container'");
  const inspector=new DatabaseSync(join(directory,'existing-reports.sqlite'),{readOnly:true});try{expect(inspector.prepare("SELECT name FROM sqlite_master WHERE type='table'").all()).toEqual([{name:'employee_reports'}]);}finally{inspector.close();}
 }finally{app.close();writer.close();rmSync(directory,{recursive:true,force:true});}
});
