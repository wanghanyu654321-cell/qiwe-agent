import {it,expect} from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import * as db from '../src/db.js';
import {DATA_DIR,STORE_DIR} from '../src/config.js';
import {BotTaskStore} from '../test-support/wecom-bot-task-store.mjs';
import {WorkbenchAccessStore} from '../test-support/workbench-access.mjs';
import {ManagerStore} from '../test-support/manager-store.mjs';
import {adminId,sessionId,memberSessionId,actor,business,employee,staff,digest,workspaceJid,folder,profileId,roleKey,receiptId,completedContent,oldTaskId,factFile,grantFile,seedEvidenceFile,retainedSnapshot} from './full-host-restoration.fixture.mts';

it('seeds retained original task/conversation facts and separate real admin/member without starting main',()=>{
 expect(process.env.QIWE_FULL_HOST_PHASE).not.toBe('restart');
 db.initDatabase();const sql=new Database(path.join(STORE_DIR,'messages.db'));
 try{
  expect(db.getRouterState('schema_version')).toBe('73');
  const now=new Date().toISOString();
  for(const [id,role]of [[adminId,'admin'],[actor.accountId,'member']] as const)
   db.createUser({id,username:id,password_hash:'synthetic-not-a-password',display_name:'Synthetic '+role,role,status:'active',must_change_password:false,created_at:now,updated_at:now});
  for(const [id,userId]of [[sessionId,adminId],[memberSessionId,actor.accountId]])db.createUserSession({id,user_id:userId,ip_address:null,user_agent:'synthetic',created_at:now,last_active_at:now,expires_at:new Date(Date.now()+3600000).toISOString()});
  // Keep each account's original Home policy. The real main revalidates it.
  db.ensureUserHomeGroup(adminId,'admin',adminId);
  db.ensureUserHomeGroup(actor.accountId,'member',actor.accountId);
  db.createAgentProfile({profileId,ownerUserId:actor.accountId,name:'Synthetic marketing',identityPrompt:'Synthetic local fixture only',promptMode:'append'});
  db.setRegisteredGroup(workspaceJid,{name:'Synthetic member role',folder,added_at:now,created_by:actor.accountId,executionMode:'container',is_home:false});
  db.ensureChatExists(workspaceJid);db.assignWorkspaceAgentProfile(folder,profileId);
  const claim=db.claimOwnedRoleWorkspace({tenantId:actor.tenantId,ownerId:actor.accountId,storeId:actor.storeId,role:'marketing',resourceKey:roleKey,corpId:actor.corpId,botId:actor.botId,memberId:actor.memberId,bindingVersion:1,grantVersion:1});
  expect(claim.state).toBe('claimed');if(claim.state!=='claimed')throw Error('RESTORATION_SEED_CLAIM_FAILED');
  expect(db.resolveOwnedRoleWorkspace(claim.claim,profileId,workspaceJid)).toBe(true);
  const selectionOrigin='restoration-old-selection',selectionId=digest([actor.corpId,actor.botId,actor.memberId,selectionOrigin]);
  const target={workspaceJid,profileId,role:'marketing',selectionId};
  const tasks=new BotTaskStore(factFile(DATA_DIR));
  try{const event={messageId:selectionOrigin,fingerprint:digest(selectionOrigin),actor,role:'marketing'};tasks.beginConversationSelection(event);tasks.finishConversationSelection(event,target);}finally{tasks.close();}
  const grants=new WorkbenchAccessStore(grantFile(DATA_DIR));
  try{grants.change('admin',{accountId:actor.accountId,storeId:actor.storeId,roles:['marketing'],active:true,expectedVersion:0,requestKey:'restoration-initial-grant'});}finally{grants.close();}
  const legacyReceipts:any[]=[];
  for(const state of ['queued','running','completed']){
   const origin='restoration-old-'+state,id=receiptId(origin);
   const receipt=db.submitBotConversationMessage({receiptId:id,originMessageId:origin,fingerprint:digest(origin),text:'Synthetic old '+state,actor,target});
   if(state!=='queued')sql.prepare("UPDATE wecom_conversation_execution SET state='running',query_id=?,turn_id=?,input_json=?,batch_size=1 WHERE receipt_id=?").run('old-query-'+state,receipt.messageId,JSON.stringify([receipt.messageId]),id);
   if(state==='completed'){
    const outputId='restoration-old-output';
    db.storeMessageDirect(outputId,workspaceJid,actor.accountId,'Synthetic',completedContent,now,true);
    sql.prepare('UPDATE messages SET turn_id=? WHERE id=? AND chat_jid=?').run(receipt.messageId,outputId,workspaceJid);
    db.noteConversationProjection(workspaceJid,'old-query-completed',receipt.messageId,receipt.messageId,outputId,completedContent);
    expect(db.finishConversationBatch(workspaceJid,'old-query-completed','completed')).toEqual([id]);
   }
   legacyReceipts.push({origin,...receipt});
  }
  db.createTask({id:oldTaskId,group_folder:folder,chat_jid:workspaceJid,prompt:'Synthetic old task preserved for manual verification',context_mode:'isolated',execution_type:'agent',execution_mode:'container',script_command:null,schedule_type:'cron',schedule_value:'0 * * * *',next_run:'2000-01-01T00:00:00.000Z',status:'active',created_at:now,created_by:actor.accountId,notify_channels:null});
  const oldRun=db.createTaskRun({task:db.getTaskById(oldTaskId)!,triggerType:'manual',idempotencyKey:'restoration-old-unknown'}).run;
  sql.prepare("UPDATE task_runs SET status='running',started_at=?,lease_owner='old-process',lease_expires_at='2000-01-01T00:00:00.000Z',notification_status='failed',notification_payload=?,notification_available_at='2000-01-01T00:00:00.000Z',notification_lease_owner='old-notifier',notification_lease_expires_at='2000-01-01T00:00:00.000Z' WHERE id=?").run(now,JSON.stringify({kind:'send_message',chatJid:workspaceJid,text:'Synthetic uncertain old send; never replay'}),oldRun.id);
  const ledger=new ManagerStore(factFile(DATA_DIR));
  const unknownId=digest('restoration-Q-unknown');
  let unknownReply;
  try{
   ledger.prepareBotReply(staff,{id:unknownId,fingerprint:digest(unknownId),target:{corpId:actor.corpId,botId:actor.botId,memberId:actor.memberId,accountId:actor.accountId,workspaceJid,storeId:actor.storeId,bindingVersion:1},conversation:{receiptId:receiptId('restoration-old-completed'),revision:1,digest:digest('old-result'),page:1,pages:1},reply:{reqId:'restoration-old-unknown',body:{msgtype:'stream',stream:{id:unknownId,finish:true,content:'Synthetic Q unknown reply; never resend'}}}});
   const claimed=ledger.claimBotReply(staff,unknownId)!;
   ledger.finishBotReply(staff,unknownId,claimed.delivery.id,claimed.delivery.attempt,{state:'unknown',apiErrorCode:null,msgid:null,detail:'synthetic_unknown'});
   unknownReply=ledger.getBotReply(staff,unknownId);
  }finally{ledger.close();}
  const evidence={processId:process.pid,adminId,actor,business,employee,target,legacyReceipts,oldRunId:oldRun.id,unknownId,unknownReply,retained:retainedSnapshot(sql)};
  fs.writeFileSync(seedEvidenceFile(),JSON.stringify(evidence,null,2));
  console.log('RESTORATION_SEED',JSON.stringify({processId:process.pid,originalSchema:db.getRouterState('schema_version'),actualUsers:['admin','member'],legacyReceiptCount:legacyReceipts.length,taskRunCount:1,unknownReplies:1}));
 }finally{sql.close();db.closeDatabase();}
});
