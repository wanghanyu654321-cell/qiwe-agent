import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {WorkbenchAccessStore} from '../dist/role-eval/workbench-access.js';
import {createNativeBotIdentityReader} from '../dist/role-eval/native-bot-identity.js';
import {createWecomBotBindingReader} from '../dist/role-eval/wecom-bot-bindings.js';
import {createWecomBotContext} from '../dist/role-eval/wecom-bot-context.js';

const directory=fs.mkdtempSync(path.join(os.tmpdir(),'qiwe-identity-demo-'));
const file=path.join(directory,'native.sqlite'),writer=new DatabaseSync(file);
writer.exec(`CREATE TABLE users(id TEXT PRIMARY KEY,role TEXT,status TEXT,must_change_password INTEGER);
  CREATE TABLE registered_groups(jid TEXT PRIMARY KEY,created_by TEXT,is_home INTEGER,execution_mode TEXT);
  INSERT INTO users VALUES('synthetic-employee','member','active',0);
  INSERT INTO registered_groups VALUES('web:synthetic-home','synthetic-employee',1,'container');`);
const grants=new WorkbenchAccessStore(path.join(directory,'access.sqlite'));
const readNative=createNativeBotIdentityReader(file);
const access=createWecomBotContext({mode:'isolated-synthetic',botId:'synthetic-bot',corpId:'synthetic-corp',tenantId:'synthetic-tenant',stores:[{id:'synthetic-store'}],roles:['manager'],store:grants,
  readSubject:async()=>({botId:'synthetic-bot',memberId:'synthetic-member'}),
  readBinding:createWecomBotBindingReader(async()=>[{botId:'synthetic-bot',corpId:'synthetic-corp',memberId:'synthetic-member',accountId:'synthetic-employee',version:1,active:true}]),readNative,
});
try{
  const grant={accountId:'synthetic-employee',storeId:'synthetic-store',roles:['manager'],active:true,expectedVersion:0,requestKey:'synthetic-opening'};
  grants.change('synthetic-admin',grant);
  const context=await access.authorize({correlationId:'synthetic-demo',signal:new AbortController().signal,deadline:performance.now()+3000},'manager');
  console.log(JSON.stringify({step:'opened',identity:context.identity,roles:context.roles}));
  grants.change('synthetic-admin',{...grant,active:false,expectedVersion:1,requestKey:'synthetic-revocation'});
  let rejected=false;
  try{await access.assertCurrent(context);}catch(error){
    if(error instanceof Error&&error.message==='access_changed'){rejected=true;console.log(JSON.stringify({step:'revoked',result:'access_changed'}));}else throw error;
  }
  if(!rejected)throw Error('revoked_context_was_accepted');
}finally{
  access.close();readNative.close();grants.close();writer.close();
  fs.rmSync(directory,{recursive:true,force:true});
}
