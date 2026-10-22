import {createHash} from 'node:crypto';

const digest=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const actorFields=['tenantId','accountId','storeId','corpId','botId','memberId','bindingVersion','grantVersion'];
const validJid=jid=>typeof jid==='string'&&/^web:(?!home(?:-|:|$))[^\s#]{1,196}$/.test(jid);
const budget=scope=>scope?.signal?.aborted!==true&&Number.isFinite(scope?.deadline)&&performance.now()<scope.deadline;
const clone=value=>structuredClone(value);

/** Candidate-only source transform. The original source tree is read-only. */
export function addBotConversationReceipts(source){
 const version='export const CURRENT_SCHEMA_VERSION = 69;';
 const anchor='    CREATE INDEX IF NOT EXISTS idx_messages_jid_ts ON messages(chat_jid, timestamp);';
 if(source.split(version).length!==2||source.split(anchor).length!==2||!source.includes('export function storeMessageDirect('))throw Error('CONVERSATION_DB_SOURCE_CHANGED');
 const table=`\n    CREATE TABLE IF NOT EXISTS wecom_conversation_receipts (
      receipt_id TEXT PRIMARY KEY,
      message_id TEXT NOT NULL,
      accepted_at TEXT NOT NULL,
      origin_message_id TEXT NOT NULL,
      fingerprint TEXT NOT NULL,
      text_hash TEXT NOT NULL,
      actor_json TEXT NOT NULL,
      role TEXT NOT NULL,
      workspace_jid TEXT NOT NULL,
      profile_id TEXT NOT NULL,
      selection_id TEXT NOT NULL
    );\n`;
 return source.replace(version,'export const CURRENT_SCHEMA_VERSION = 70;').replace(anchor,anchor+table)+`

export interface BotConversationNativeActor {
  tenantId:string;accountId:string;storeId:string;corpId:string;botId:string;memberId:string;
  bindingVersion:number;grantVersion:number;
}
export interface BotConversationNativeReceipt {
  receiptId:string;messageId:string;acceptedAt:string;state:'accepted';role:string;
  workspaceJid:string;profileId:string;selectionId:string;fingerprint:string;
}
interface BotConversationNativeSubmit {
  receiptId:string;originMessageId:string;fingerprint:string;text:string;
  actor:BotConversationNativeActor;target:{workspaceJid:string;profileId:string;role:string;selectionId:string};
}
const conversationDigest=(value:unknown)=>crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
const conversationRow=(row:any):BotConversationNativeReceipt=>({
  receiptId:row.receipt_id,messageId:row.message_id,acceptedAt:row.accepted_at,state:'accepted',
  role:row.role,workspaceJid:row.workspace_jid,profileId:row.profile_id,
  selectionId:row.selection_id,fingerprint:row.fingerprint,
});
export function readBotConversationReceipt(receiptId:string):BotConversationNativeReceipt & {actor:BotConversationNativeActor;originMessageId:string;textHash:string}|undefined {
  const row=db.prepare('SELECT * FROM wecom_conversation_receipts WHERE receipt_id=?').get(receiptId) as any;
  if(!row)return undefined;
  const actor=JSON.parse(row.actor_json) as BotConversationNativeActor;
  if(row.receipt_id!==conversationDigest([actor.corpId,actor.botId,actor.memberId,row.origin_message_id]))
    throw Error('CONVERSATION_RECEIPT_ORIGIN_MISMATCH');
  const message=db.prepare('SELECT id,source_jid,sender,content,timestamp,is_from_me FROM messages WHERE id=? AND chat_jid=?').get(row.message_id,row.workspace_jid) as any;
  if(!message||message.source_jid!==row.workspace_jid||message.sender!==actor.accountId||
     message.timestamp!==row.accepted_at||message.is_from_me!==0||
     conversationDigest(message.content)!==row.text_hash)throw Error('CONVERSATION_RECEIPT_MESSAGE_MISMATCH');
  return {...conversationRow(row),actor,
    originMessageId:row.origin_message_id,textHash:row.text_hash};
}
export function submitBotConversationMessage(input:BotConversationNativeSubmit):BotConversationNativeReceipt {
  return db.transaction(() => {
    if(!input.originMessageId||input.receiptId!==conversationDigest([input.actor.corpId,input.actor.botId,input.actor.memberId,input.originMessageId]))
      throw Error('CONVERSATION_ORIGIN_INVALID');
    const existing=readBotConversationReceipt(input.receiptId);
    const textHash=conversationDigest(input.text);
    if(existing){
      if(JSON.stringify(existing.actor)!==JSON.stringify(input.actor)||existing.originMessageId!==input.originMessageId||
         existing.fingerprint!==input.fingerprint||existing.textHash!==textHash)throw Error('CONVERSATION_ORIGIN_CONFLICT');
      return {receiptId:existing.receiptId,messageId:existing.messageId,acceptedAt:existing.acceptedAt,
        state:'accepted' as const,role:existing.role,workspaceJid:existing.workspaceJid,
        profileId:existing.profileId,selectionId:existing.selectionId,fingerprint:existing.fingerprint};
    }
    const acceptedAt=new Date().toISOString(),messageId=crypto.randomUUID();
    ensureChatExists(input.target.workspaceJid);
    const owner=getUserById(input.actor.accountId);
    if(!owner||owner.id!==input.actor.accountId||owner.role!=='member'||owner.status!=='active'||owner.must_change_password!==false)
      throw Error('CONVERSATION_OWNER_INVALID');
    storeMessageDirect(messageId, input.target.workspaceJid, input.actor.accountId,
      owner.display_name, input.text, acceptedAt, false);
    db.prepare(\`INSERT INTO wecom_conversation_receipts
      (receipt_id,message_id,accepted_at,origin_message_id,fingerprint,text_hash,actor_json,role,workspace_jid,profile_id,selection_id)
      VALUES (?,?,?,?,?,?,?,?,?,?,?)\`).run(input.receiptId,messageId,acceptedAt,input.originMessageId,
        input.fingerprint,textHash,JSON.stringify(input.actor),input.target.role,input.target.workspaceJid,
        input.target.profileId,input.target.selectionId);
    return {receiptId:input.receiptId,messageId,acceptedAt,state:'accepted' as const,
      role:input.target.role,workspaceJid:input.target.workspaceJid,profileId:input.target.profileId,
      selectionId:input.target.selectionId,fingerprint:input.fingerprint};
  })();
}
`;
}

/** Isolated Native boundary; the caller's authority callback encloses the synchronous DB commit. */
export function createBotConversationNativePort({mode,gate,native,readActor,execution}){
 if(mode!=='isolated-synthetic'||!gate||!native||typeof readActor!=='function'||
   typeof gate.isPaused!=='function'||typeof gate.beginWrite!=='function'||typeof gate.finishWrite!=='function'||
   typeof native.readBotConversationReceipt!=='function'||typeof native.submitBotConversationMessage!=='function')
   throw Error('CONVERSATION_BINDING_INCOMPLETE');
 if(execution&&(typeof execution.enqueue!=='function'||typeof execution.cancel!=='function'||typeof native.readConversationExecution!=='function'))throw Error('CONVERSATION_EXECUTION_BINDING_INCOMPLETE');
 const dispatch=execution?Object.freeze({...execution}):undefined;
 const policy=Object.freeze({...gate}),source=Object.freeze({...native}),trustedReadActor=readActor;
 function snapshot(input){
  const actor=Object.freeze({...input.actor}),roles=Object.freeze([...input.roles]);
  const scope=Object.freeze({signal:input.scope.signal,deadline:input.scope.deadline,correlationId:input.scope.correlationId});
  if(actorFields.some(field=>actor[field]===undefined)||typeof input.receiptId!=='string'||!Array.isArray(input.roles))throw Error('CONVERSATION_INPUT_INVALID');
  return {actor,roles,receiptId:input.receiptId,scope,
   originMessageId:input.originMessageId,fingerprint:input.fingerprint,text:input.text,
   target:input.target?Object.freeze({...input.target}):undefined,
   assertCurrent:input.assertCurrent,withCurrent:input.withCurrent};
 }
 async function current(input){
  await input.assertCurrent();
  const observed=clone(await trustedReadActor(Object.freeze({...input.scope})));
  if(actorFields.some(field=>observed?.[field]!==input.actor[field]))throw Error('CONVERSATION_ACTOR_CHANGED');
  if(!budget(input.scope)||policy.isPaused())throw Error('CONVERSATION_MAINTENANCE');
 }
 function owner(actor){
  const row=source.getUserById(actor.accountId);
  if(!row||row.id!==actor.accountId||row.role!=='member'||row.status!=='active'||row.must_change_password!==false)throw Error('CONVERSATION_OWNER_INVALID');
 }
 function checkReceipt(input,stored){
  if(!stored)return undefined;
  if(actorFields.some(field=>stored.actor?.[field]!==input.actor[field])||
    !input.roles.includes(stored.role)||stored.receiptId!==input.receiptId)throw Error('CONVERSATION_RECEIPT_DENIED');
  const {actor:_actor,originMessageId:_origin,textHash:_hash,...receipt}=stored;
  return {...receipt,...(dispatch?{execution:source.readConversationExecution(stored.receiptId)}:{})};
 }
 function checkTarget(input){
  const t=input.target,a=input.actor;
  if(!t||!validJid(t.workspaceJid)||!t.profileId||!t.selectionId||!input.roles.includes(t.role)||
    typeof input.originMessageId!=='string'||!input.originMessageId||
    typeof input.text!=='string'||!input.text.trim()||typeof input.fingerprint!=='string'||!input.fingerprint||
    input.receiptId!==digest([a.corpId,a.botId,a.memberId,input.originMessageId]))throw Error('CONVERSATION_INPUT_INVALID');
  const key=digest([a.tenantId,a.accountId,a.storeId,t.role]);
  const claim=source.getOwnedRoleWorkspaceClaim(key);
  if(!claim||claim.state!=='ready'||claim.tenantId!==a.tenantId||claim.ownerId!==a.accountId||claim.storeId!==a.storeId||
    claim.role!==t.role||claim.corpId!==a.corpId||claim.botId!==a.botId||claim.memberId!==a.memberId||
    claim.bindingVersion!==a.bindingVersion||claim.grantVersion!==a.grantVersion||
    claim.workspaceJid!==t.workspaceJid||claim.profileId!==t.profileId)throw Error('CONVERSATION_PROVENANCE_INVALID');
  const group=source.getRegisteredGroup(t.workspaceJid),profile=source.getAgentProfileForUser(t.profileId,a.accountId);
  if(!group||group.created_by!==a.accountId||group.is_home||group.executionMode!=='container'||!group.folder||
    !profile||profile.owner_user_id!==a.accountId||profile.status==='archived'||
    source.getWorkspaceAgentProfileId(group.folder)!==t.profileId)throw Error('CONVERSATION_WORKSPACE_INVALID');
 }
 async function guarded(input,work){
  if(policy.isPaused())throw Error('CONVERSATION_MAINTENANCE');
  const ticket=policy.beginWrite();if(!ticket)throw Error('CONVERSATION_MAINTENANCE');
  try{if(!budget(input.scope))throw Error('CONVERSATION_BUDGET_EXPIRED');return await work();}
  finally{policy.finishWrite(ticket);}
 }
 return Object.freeze({
  readReceipt(raw){const input=snapshot(raw);return guarded(input,async()=>{
    await current(input);owner(input.actor);
    const result=await input.withCurrent(()=>{
      if(!budget(input.scope)||policy.isPaused())throw Error('CONVERSATION_BUDGET_EXPIRED');
      owner(input.actor);return checkReceipt(input,source.readBotConversationReceipt(input.receiptId));
    });
    return result;
  });},
  ...(dispatch?{cancelReceipt(raw){const input=snapshot(raw);return guarded(input,async()=>{
    await current(input);owner(input.actor);
    return input.withCurrent(()=>{
      if(!budget(input.scope)||policy.isPaused())throw Error('CONVERSATION_BUDGET_EXPIRED');
      owner(input.actor);
      const stored=source.readBotConversationReceipt(input.receiptId);checkReceipt(input,stored);
      if(!stored)return undefined;
      dispatch.cancel(input.receiptId);return checkReceipt(input,source.readBotConversationReceipt(input.receiptId));
    });
  });}}:{}),
  submitMessage(raw){const input=snapshot(raw);return guarded(input,async()=>{
    await current(input);
    return input.withCurrent(()=>{
      if(!budget(input.scope)||policy.isPaused())throw Error('CONVERSATION_BUDGET_EXPIRED');
      owner(input.actor);
      const existing=source.readBotConversationReceipt(input.receiptId);
      if(existing){
        checkReceipt(input,existing);
        if(existing.originMessageId!==input.originMessageId||existing.fingerprint!==input.fingerprint||
          existing.textHash!==digest(input.text))throw Error('CONVERSATION_ORIGIN_CONFLICT');
        return checkReceipt(input,existing);
      }
      checkTarget(input);
      const saved=source.submitBotConversationMessage({receiptId:input.receiptId,originMessageId:input.originMessageId,
        fingerprint:input.fingerprint,text:input.text,actor:{...input.actor},target:{...input.target}});
      dispatch?.enqueue(saved.receiptId);
      return checkReceipt(input,source.readBotConversationReceipt(saved.receiptId));
    });
  });},
 });
}
