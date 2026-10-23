import {expect,vi} from 'vitest';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {BotTaskStore} from '../test-support/wecom-bot-task-store.mjs';
import {createBotConversationNativePort} from '../test-support/conversation-overlay.mjs';
import {createRoleWorkspaceNativePort} from '../test-support/role-workspace-overlay.mjs';
import {prepareOwnProfiles} from '../test-support/workbench-opening.mjs';
import {ManagerStore} from '../test-support/manager-store.mjs';
import {WorkbenchAccessStore} from '../test-support/workbench-access.mjs';
import {createWecomBotAssembly} from '../test-support/wecom-bot-assembly.mjs';
import {createWecomBotPreparation} from '../test-support/wecom-bot-preparation.mjs';
import {createBotSdkAdapter} from '../test-support/wecom-bot-sdk.mjs';
import {createBotConversationDelivery} from '../test-support/wecom-bot-delivery.mjs';
import {createWecomBotContext} from '../test-support/wecom-bot-context.mjs';
import {createBotSender} from '../test-support/wecom-bot-sender.mjs';
import {offlineBotSdk} from '../test-support/offline-bot-sdk.mjs';
import {DatabaseSync} from 'node:sqlite';

const actor={tenantId:'full-tenant',accountId:'synthetic-full-admin',storeId:'full-store',corpId:'full-corp',botId:'full-bot',memberId:'full-subject',bindingVersion:1,grantVersion:1};
const digest=(value:unknown)=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const event={messageId:'historical-selection',fingerprint:digest('selection'),actor,role:'marketing'};
const target={workspaceJid:'web:full-role',profileId:'historical-profile',role:'marketing',selectionId:digest([actor.corpId,actor.botId,actor.memberId,event.messageId])};
const id=(state:string)=>digest([actor.corpId,actor.botId,actor.memberId,'historical-'+state]);
const file=(config:any)=>path.join(config.DATA_DIR,'fullhost-conversation-facts.sqlite');
const business={tenant:actor.tenantId,store:actor.storeId,workspace:'web:original'};
const employee={accountId:actor.accountId,employeeId:'full-employee',employeeName:'Synthetic'};
const staff={...business,employeeId:employee.employeeId,employeeName:employee.employeeName};
const request=(state='queued')=>({actor:{...actor},roles:['marketing'],receiptId:id(state),originMessageId:'historical-'+state,fingerprint:digest(state),text:'synthetic '+state,target,
 scope:{signal:new AbortController().signal,deadline:performance.now()+10000,correlationId:'fullhost-conversation'},assertCurrent:async()=>{},withCurrent:async<T>(work:()=>T)=>work()});

// Pre-existing synthetic records exercise preservation only. They are never
// counted as work accepted/executed by this paused host, or as recovered output.
export async function seed(db:any,sql:any,config:any){
 expect(db.getRouterState('schema_version')).toBe('73');
 const now=new Date().toISOString();
 // Historical member input; this account is an admin at the current boot.
 // Keeping one owner also honors O's all-resources maintenance ACL.
 sql.prepare("UPDATE users SET role='member' WHERE id=?").run(actor.accountId);
 const tasks=new BotTaskStore(file(config));
 try{tasks.beginConversationSelection(event);tasks.finishConversationSelection(event,target);}finally{tasks.close();}
 for(const state of ['queued','running','cancelling','completed']){
  const input=request(state),receipt=db.submitBotConversationMessage(input);
  expect(db.readConversationExecution(receipt.receiptId)?.state).toBe('queued');
  sql.prepare('UPDATE wecom_conversation_execution SET state=?,query_id=?,turn_id=?,session_id=? WHERE receipt_id=?').run(state,'historical-query-'+state,receipt.messageId,'historical-session',receipt.receiptId);
  if(state==='completed'){
   const outputId='historical-output',content='synthetic historical frozen output';
   db.storeMessageDirect(outputId,target.workspaceJid,actor.accountId,'Synthetic',content,now,true);
   sql.prepare('UPDATE messages SET turn_id=? WHERE id=?').run(receipt.messageId,outputId);
   sql.prepare('INSERT INTO wecom_conversation_results VALUES (?,?,?,?,?,?,?,?)').run(receipt.receiptId,1,'historical-query-completed',receipt.messageId,'historical-session',JSON.stringify([outputId]),createHash('sha256').update(content).digest('hex'),content);
  }
 }
 sql.prepare("UPDATE users SET role='admin' WHERE id=?").run(actor.accountId);
 const grants=new WorkbenchAccessStore(path.join(config.DATA_DIR,'fullhost-grants.sqlite'));
 try{grants.change('admin',{accountId:actor.accountId,storeId:actor.storeId,roles:['marketing'],active:true,expectedVersion:0,requestKey:'historical-grant'});}finally{grants.close();}
 const ledger=new ManagerStore(file(config));
 try{for(const state of ['prepared','attempting','unknown']){
  const key=digest('historical-reply-'+state);
  const intent=ledger.prepareBotReply(staff,{id:key,fingerprint:digest(key),target:{corpId:actor.corpId,botId:actor.botId,memberId:actor.memberId,accountId:actor.accountId,workspaceJid:target.workspaceJid,storeId:actor.storeId,bindingVersion:1},conversation:{receiptId:id('completed'),revision:1,digest:digest('historical'),page:1,pages:1},reply:{reqId:'historical-'+state,body:{msgtype:'stream',stream:{id:key,finish:true,content:'synthetic old notification'}}}});
  if(state!=='prepared'){const claim=ledger.claimBotReply(staff,key)!;if(state==='unknown')ledger.finishBotReply(staff,key,claim.delivery.id,claim.delivery.attempt,{state:'unknown',apiErrorCode:null,msgid:null,detail:'synthetic_unknown'});}
 }}finally{ledger.close();}
}

export function snapshot(sql:any,config:any){
 const tasks=new BotTaskStore(file(config)),facts=new DatabaseSync(file(config),{readOnly:true});
 try{return {selection:tasks.currentConversation(actor),replies:facts.prepare('SELECT * FROM bot_reply_intents ORDER BY id').all(),receipts:sql.prepare('SELECT * FROM wecom_conversation_receipts ORDER BY receipt_id').all(),executions:sql.prepare('SELECT * FROM wecom_conversation_execution ORDER BY receipt_id').all(),results:sql.prepare('SELECT * FROM wecom_conversation_results ORDER BY receipt_id,revision').all()};}finally{facts.close();tasks.close();}
}

export async function exercise({db,host,context,config,sql,snapshot:takeSnapshot,before,events}:any){
 expect(typeof host.initializeFullHostConversationExecution).toBe('function');
 const authorize=vi.fn(()=>true),completed=vi.fn();
 const options={mode:'isolated-synthetic',authorize,onCompleted:completed};
 const execution=host.initializeFullHostConversationExecution(options);
 expect(execution.queue).toBe(host.fullHostQueue);
 expect(execution.gate).toBe(host.fullHostBootGate);
 expect(context.getWebDeps().queue).toBe(execution.queue);
 // Binding on the real main must not recover running/cancelling records, nor
 // enqueue old receipts or emit callbacks before original restore COMMIT.
 expect(takeSnapshot()).toEqual(before);
 const {createOwnedRoleProfile}=await import('../src/routes/agent-profiles.js');
 const {createOwnedRoleWorkspace}=await import('../src/routes/groups.js');
 const native={...db,createOwnedRoleProfile,createOwnedRoleWorkspace,listAvailableSkills:async()=>[]};
 const port=createBotConversationNativePort({mode:'isolated-synthetic',gate:execution.gate,native,readActor:async()=>({...actor}),execution});
 const rolePort=createRoleWorkspaceNativePort({mode:'isolated-synthetic',gate:execution.gate,native,readActor:async()=>({...actor,role:'marketing'}),templates:[],prepareOwnProfiles,journalDirectory:path.join(config.DATA_DIR,'unused-fullhost-journal')});
 const grants=new WorkbenchAccessStore(path.join(config.DATA_DIR,'fullhost-grants.sqlite'));
 const ledger=new ManagerStore(file(config)),tasks=new BotTaskStore(file(config));
 const readBinding=vi.fn(async()=>({botId:actor.botId,corpId:actor.corpId,memberId:actor.memberId,accountId:actor.accountId,active:true,version:1}));
 const readNative=vi.fn(async()=>({user:db.getUserById(actor.accountId),workspaceJid:'web:home-'+actor.accountId}));
 const identity={tenantId:actor.tenantId,stores:[{id:actor.storeId}],roles:['marketing'],store:grants,readBinding,readNative};
 try{
  for(const text of ['岗位 内容营销','synthetic new input','查询对话 '+id('completed'),'取消对话 '+id('running')]){
   const offline=offlineBotSdk();offline.lifecycle('disconnected');
   const manager=Reflect.get(offline.client,'wsManager') as any;
   let assembly:any,adapter:any;
   const preparation=createWecomBotPreparation({mode:'isolated-synthetic',gate:execution.gate,createClient:()=>offline.client,
    connect:()=>{offline.lifecycle('connected');manager.handleFrame({headers:{req_id:'aibot_subscribe_fullhost'},errcode:0});},
    disconnect:()=>{offline.lifecycle('disconnected');manager.disconnect();},
    readFingerprint:()=>({botId:actor.botId,corpId:actor.corpId,ownerId:actor.accountId,configVersion:'1',credentialFingerprint:'synthetic',workspaceFingerprint:'synthetic'}),
    assemble:(client:any,executionBoundary:any)=>{
     adapter=createBotSdkAdapter({mode:'isolated-synthetic',client});
     assembly=createWecomBotAssembly({mode:'isolated-synthetic',client,botId:actor.botId,corpId:actor.corpId,identity,
      businesses:[{scope:business,employees:[employee],ledger,conversations:{store:tasks,native:rolePort,intake:port,deliveryGate:execution.gate}}],sender:{sdk:adapter},executionBoundary});
     return {close:()=>{assembly.close();adapter.close();},idle:()=>assembly.idle()};
    }});
   try{
    await expect(preparation.prepare()).resolves.toBe('prepared');expect(preparation.activate()).toBe(false);
    offline.frame({cmd:'aibot_msg_callback',headers:{req_id:'fullhost-'+digest(text)},body:{msgid:'fullhost-'+digest(text),aibotid:actor.botId,msgtype:'text',chattype:'single',create_time:1792458100,from:{userid:actor.memberId,corpid:actor.corpId},text:{content:text}}});
    await assembly.idle();expect(preparation.failure()).toBe('input_not_accepted');
    expect(offline.sent).toEqual([]);expect(offline.connect).not.toHaveBeenCalled();expect(takeSnapshot()).toEqual(before);
   }finally{await preparation.close();}
  }
  const offline=offlineBotSdk(),adapter=createBotSdkAdapter({mode:'isolated-synthetic',client:offline.client});
  const authority=createWecomBotContext({...identity,mode:'isolated-synthetic',botId:actor.botId,corpId:actor.corpId,readSubject:async()=>({botId:actor.botId,memberId:actor.memberId})});
  const sender=createBotSender({sdk:adapter});
  try{
   const delivery=createBotConversationDelivery({authority,ledger,sender,intake:port,gate:execution.gate,scope:business,employees:[employee]});
   await expect(delivery.recover(request().scope,id('completed'))).rejects.toThrow('conversation_maintenance');
   expect(offline.sent).toEqual([]);expect(readBinding).not.toHaveBeenCalled();expect(readNative).not.toHaveBeenCalled();expect(takeSnapshot()).toEqual(before);
  }finally{authority.close();sender.close();adapter.close();}
 }finally{grants.close();ledger.close();tasks.close();}
 expect(execution.queue.getRecoveryObligations()).toMatchObject({pendingMessageGroups:0,pendingTasks:0});
 for(const work of [()=>port.readReceipt(request()),()=>port.readResults(request('completed')),()=>port.cancelReceipt(request()),()=>port.submitMessage(request())])
  await expect(work()).rejects.toThrow('CONVERSATION_MAINTENANCE');
 expect(await rolePort.prepareRoleWorkspace({actor:{...actor,role:'marketing'},scope:request().scope,idempotencyKey:digest([actor.tenantId,actor.accountId,actor.storeId,'marketing']),assertCurrent:async()=>{},withCurrent:async<T>(work:()=>T)=>work()})).toMatchObject({state:'unknown'});
 for(const work of [()=>execution.enqueue(id('queued')),()=>execution.cancel(id('running'))])expect(work).toThrow('CONVERSATION_MAINTENANCE');
 expect(authorize).not.toHaveBeenCalled();expect(completed).not.toHaveBeenCalled();
 expect(takeSnapshot()).toEqual(before);
 // These DB reads are the original maintenance observer, not an employee
 // query success: the public conversation port above correctly refuses reads.
 expect(db.readBotConversationReceipt(id('queued'))).toMatchObject({selectionId:target.selectionId});
 expect(db.readConversationExecution(id('running'))).toMatchObject({state:'running'});
 expect(db.readConversationExecution(id('cancelling'))).toMatchObject({state:'cancelling'});
 expect(db.readConversationResults(id('completed'))).toHaveLength(1);
 const readTasks=new BotTaskStore(file(config));
 try{expect(readTasks.currentConversation(actor)).toMatchObject({state:'ready',workspaceJid:target.workspaceJid,profileId:target.profileId});}finally{readTasks.close();}
 expect(takeSnapshot()).toEqual(before);
 events.push('fullhost-D1-selection-D2-receipts-D3-inflight-D5-historical-results-preserved');
 events.push('fullhost-same-main-queue-gate-refuses-intake-query-cancel-delivery-and-no-startup-replay');
}
