import {expect} from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import {createBotConversationNativePort} from '../test-support/conversation-overlay.mjs';
import {createRoleWorkspaceNativePort} from '../test-support/role-workspace-overlay.mjs';
import {prepareOwnProfiles} from '../test-support/workbench-opening.mjs';
import {WorkbenchAccessStore} from '../test-support/workbench-access.mjs';
import {ManagerStore} from '../test-support/manager-store.mjs';
import {BotTaskStore} from '../test-support/wecom-bot-task-store.mjs';
import {createWecomBotAssembly} from '../test-support/wecom-bot-assembly.mjs';
import {createWecomBotPreparation} from '../test-support/wecom-bot-preparation.mjs';
import {createBotSdkAdapter} from '../test-support/wecom-bot-sdk.mjs';
import {createWecomBotContext} from '../test-support/wecom-bot-context.mjs';
import {createBotConversationDelivery} from '../test-support/wecom-bot-delivery.mjs';
import {createBotSender} from '../test-support/wecom-bot-sender.mjs';
import {offlineBotSdk} from '../test-support/offline-bot-sdk.mjs';
import {actor,business,employee,staff,digest,workspaceJid,completedContent,receiptId,factFile,grantFile,retainedSnapshot} from './full-host-restoration.fixture.mts';

export async function exerciseEmployeeRestoration({host,db,config,sql,boundary,seed,transportCalls,events}:any){
 const restarting=process.env.QIWE_FULL_HOST_PHASE==='restart';
 const grants=new WorkbenchAccessStore(grantFile(config.DATA_DIR)),ledger=new ManagerStore(factFile(config.DATA_DIR)),tasks=new BotTaskStore(factFile(config.DATA_DIR));
 const offline=offlineBotSdk();offline.lifecycle('disconnected');
 const scope=()=>({signal:new AbortController().signal,deadline:performance.now()+10000,correlationId:'restoration-result-delivery'});
 const identity={tenantId:actor.tenantId,stores:[{id:actor.storeId}],roles:['marketing'],store:grants,
  readBinding:async()=>({botId:actor.botId,corpId:actor.corpId,memberId:actor.memberId,accountId:actor.accountId,active:true,version:1}),
  readNative:async()=>({user:db.getUserById(actor.accountId),workspaceJid:'web:home-'+actor.accountId})};
 const authority=createWecomBotContext({...identity,mode:'isolated-synthetic',botId:actor.botId,corpId:actor.corpId,readSubject:async()=>({botId:actor.botId,memberId:actor.memberId})});
 let delivery:any,assembly:any,adapter:any,sender:any,completedDeliveries:any[]=[];
 const execution=host.initializeFullHostConversationExecution({mode:'isolated-synthetic',
  authorize:(receipt:any)=>{
   if(!receipt)return false;const grant=grants.get(receipt.actor.accountId);
   return !!grant?.active&&grant.version===receipt.actor.grantVersion&&grant.storeId===receipt.actor.storeId&&grant.roles.includes(receipt.role)&&Object.entries(actor).every(([key,value])=>receipt.actor[key]===value);
  },
  onCompleted:async(ids:string[])=>{for(const id of ids)completedDeliveries.push(await delivery.recover(scope(),id));},
 });
 expect(execution.queue).toBe(host.fullHostQueue);expect(execution.gate).toBe(host.fullHostBootGate);
 const {createOwnedRoleProfile}=await import('../src/routes/agent-profiles.js'),{createOwnedRoleWorkspace}=await import('../src/routes/groups.js');
 const native={...db,createOwnedRoleProfile,createOwnedRoleWorkspace,listAvailableSkills:async()=>[]};
 const port=createBotConversationNativePort({mode:'isolated-synthetic',gate:execution.gate,native,readActor:async()=>({...actor}),execution});
 const roles=createRoleWorkspaceNativePort({mode:'isolated-synthetic',gate:execution.gate,native,templates:[{key:'marketing',name:'Synthetic marketing',skills:[],payload:{name:'Synthetic marketing',prompt_schema_version:2}}],prepareOwnProfiles,journalDirectory:path.join(config.DATA_DIR,'restoration-unused-role-journal'),readActor:async()=>({...actor,role:'marketing'})});
 const manager=Reflect.get(offline.client,'wsManager') as any;
 const preparation=createWecomBotPreparation({mode:'isolated-synthetic',gate:execution.gate,createClient:()=>offline.client,
  connect:()=>{offline.lifecycle('connected');manager.handleFrame({headers:{req_id:'aibot_subscribe_restoration'},errcode:0});},
  disconnect:()=>{offline.lifecycle('disconnected');manager.disconnect();},
  readFingerprint:()=>({botId:actor.botId,corpId:actor.corpId,ownerId:actor.accountId,configVersion:'1',credentialFingerprint:'synthetic-only',workspaceFingerprint:digest(workspaceJid)}),
  assemble:(client:any,executionBoundary:any)=>{
   adapter=createBotSdkAdapter({mode:'isolated-synthetic',client});sender=createBotSender({sdk:adapter});
   delivery=createBotConversationDelivery({authority,ledger,sender,intake:port,gate:execution.gate,scope:business,employees:[employee]});
   assembly=createWecomBotAssembly({mode:'isolated-synthetic',client,botId:actor.botId,corpId:actor.corpId,identity,
    businesses:[{scope:business,employees:[employee],ledger,conversations:{store:tasks,native:roles,intake:port,deliveryGate:execution.gate}}],sender:{sdk:adapter},executionBoundary});
   return {close:()=>{assembly.close();sender.close();adapter.close();},idle:()=>assembly.idle()};
  }});
 const marker=path.join(process.cwd(),'restoration-employee-result.json');
 const oldReply=()=>ledger.getBotReply(staff,seed.unknownId);
 const send=async(id:string,text:string)=>{
  const req='restoration-'+id;
  offline.frame({cmd:'aibot_msg_callback',headers:{req_id:req},body:{msgid:id,aibotid:actor.botId,msgtype:'text',chattype:'single',create_time:1792458000,from:{userid:actor.memberId,corpid:actor.corpId},text:{content:text}}});
  await assembly.idle();return req;
 };
 const reply=(req:string)=>offline.sent.findLast(frame=>frame.cmd==='aibot_respond_msg'&&frame.headers.req_id===req);
 try{
  expect(oldReply()).toEqual(seed.unknownReply);expect(offline.sent).toEqual([]);expect(transportCalls).toEqual([]);
  await expect(preparation.prepare()).resolves.toBe('prepared');expect(preparation.activate()).toBe(true);
  // Activation must not replay any retained task, D2 input or uncertain Q reply.
  await assembly.idle();expect(offline.sent).toEqual([]);expect(transportCalls).toEqual([]);
  const selectionReq=await send((restarting?'restart':'boot')+'-select','岗位 内容营销');
  expect(JSON.stringify(reply(selectionReq))).toContain('已选择');expect(tasks.currentConversation(actor)).toMatchObject({state:'ready',workspaceJid});
  for(const record of seed.legacyReceipts.filter((item:any)=>item.origin!=='restoration-old-completed')){
   const req=await send((restarting?'restart':'boot')+'-query-'+record.origin,'查询对话 '+record.receiptId);
   expect(JSON.stringify(reply(req))).toContain('待人工核对');expect(transportCalls).toEqual([]);
  }
  const historicalReq=await send((restarting?'restart':'boot')+'-query-historical','查询对话 '+receiptId('restoration-old-completed'));
  expect(JSON.stringify(reply(historicalReq))).toContain(completedContent);
  expect(JSON.stringify(reply(historicalReq))).toContain('待人工核对');expect(transportCalls).toEqual([]);
  if(!restarting){
   const origin='restoration-new-demand',id=receiptId(origin);
   const requestId=await send(origin,'请为同一岗位生成这条新的合成需求答案。');
   expect(JSON.stringify(reply(requestId))).toContain(id);
   await boundary.wait(()=>db.readConversationExecution(id)?.state==='completed','actual original queue produces completed D3 and D5');
   await boundary.wait(()=>completedDeliveries.length===1,'actual frozen result delivery settles');
   expect(transportCalls).toHaveLength(1);expect(transportCalls[0].prompt).toContain('这条新的合成需求');
   expect(transportCalls[0].prompt).not.toContain('Synthetic old running');expect(transportCalls[0].prompt).not.toContain('Synthetic old queued');
   const results=db.readConversationResults(id);expect(results).toHaveLength(1);expect(results[0]).toMatchObject({receiptId:id,revision:1,content:'合成恢复后答案'});
   const canonical=sql.prepare('SELECT * FROM messages WHERE id=? AND chat_jid=?').get(results[0].sourceOutputIds[0],workspaceJid) as any;
   expect(canonical).toMatchObject({content:results[0].content,turn_id:results[0].turnId,is_from_me:1});
   const proactive=offline.sent.filter(frame=>frame.cmd==='aibot_send_msg');expect(proactive).toHaveLength(1);
   expect(proactive[0].body).toMatchObject({chatid:actor.memberId,chat_type:1,msgtype:'markdown'});expect(JSON.stringify(proactive[0].body)).toContain('合成恢复后答案');
   expect(completedDeliveries[0].deliveries).toMatchObject([{state:'accepted'}]);
   const queryReq=await send('boot-query-new','查询对话 '+id);expect(JSON.stringify(reply(queryReq))).toContain('合成恢复后答案');
   fs.writeFileSync(marker,JSON.stringify({processId:process.pid,receiptId:id,result:results[0]},null,2));
   events.push('same-host-offline-sdk-identity-D1-D2-original-queue-D3-canonical-D5-reply-and-query');
  }else{
   const first=JSON.parse(fs.readFileSync(marker,'utf8'));expect(first.processId).not.toBe(process.pid);
   const results=db.readConversationResults(first.receiptId);expect(results).toEqual([first.result]);
   const queryReq=await send('restart-query-new','查询对话 '+first.receiptId);
   expect(JSON.stringify(reply(queryReq))).toContain('合成恢复后答案');expect(transportCalls).toEqual([]);expect(completedDeliveries).toEqual([]);
   expect(offline.sent.filter(frame=>frame.cmd==='aibot_send_msg')).toEqual([]);
   events.push('new-os-process-restores-same-host-and-sdk-queries-existing-D5-without-reexecution');
  }
  expect(oldReply()).toEqual(seed.unknownReply);expect(retainedSnapshot(sql)).toEqual(seed.retained);
  for(const frame of offline.sent)expect(JSON.stringify(frame)).not.toContain('Synthetic Q unknown reply; never resend');
  expect(offline.connect).not.toHaveBeenCalled();expect(boundary.blocked).toEqual([]);
  events.push('retained-task-D2-and-Q-unknown-unchanged-no-automatic-resume-or-resend');
  return {sdkReplies:offline.sent.filter(frame=>frame.cmd==='aibot_respond_msg').length,sdkNotifies:offline.sent.filter(frame=>frame.cmd==='aibot_send_msg').length,runnerCalls:transportCalls.length};
 }finally{await preparation.close();authority.close();grants.close();ledger.close();tasks.close();}
}
