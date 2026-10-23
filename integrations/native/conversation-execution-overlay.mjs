import fs from 'node:fs';
const once=(source,before,after)=>{if(source.split(before).length!==2)throw Error('D3_ANCHOR_CHANGED: '+before.slice(0,100));return source.replace(before,after);};
export function applyConversationExecution(files,native){
 for(const name of ['index.ts','group-queue.ts','conversation-history.ts'])if(!native.has(name))throw Error('D3_SOURCE_MISSING: '+name);
 const result=new Map(files);
 let db=result.get('db.ts');if(!db?.includes('wecom_conversation_receipts'))throw Error('D3_INTAKE_REQUIRED');
 db=once(db,'export const CURRENT_SCHEMA_VERSION = 70;','export const CURRENT_SCHEMA_VERSION = 72;');
 db=once(db,'    CREATE TABLE IF NOT EXISTS wecom_conversation_receipts (',`    CREATE TABLE IF NOT EXISTS wecom_conversation_execution (
 receipt_id TEXT PRIMARY KEY,workspace_jid TEXT NOT NULL,message_id TEXT NOT NULL,
 state TEXT NOT NULL,query_id TEXT,turn_id TEXT,session_id TEXT,input_json TEXT,batch_size INTEGER
    );
    CREATE TABLE IF NOT EXISTS wecom_conversation_results (
 receipt_id TEXT NOT NULL,revision INTEGER NOT NULL,query_id TEXT NOT NULL,turn_id TEXT NOT NULL,
 session_id TEXT,source_ids_json TEXT NOT NULL,digest TEXT NOT NULL,content TEXT NOT NULL,
 PRIMARY KEY(receipt_id,revision),UNIQUE(receipt_id,query_id,digest)
    );
    CREATE TABLE IF NOT EXISTS wecom_conversation_receipts (`);
 db=once(db,'input.target.profileId,input.target.selectionId);','input.target.profileId,input.target.selectionId);\n    queueConversationReceipt(input.receiptId);');
 db=once(db,`  db.prepare(
    'INSERT OR REPLACE INTO router_state (key, value) VALUES (?, ?)',
  ).run('schema_version', String(CURRENT_SCHEMA_VERSION));`, `  db.transaction(()=>{
    if(Number(rawSchemaVersionBeforeInit??0)<71) {
      db.prepare("INSERT OR IGNORE INTO wecom_conversation_execution(receipt_id,workspace_jid,message_id,state) SELECT receipt_id,workspace_jid,message_id,'queued' FROM wecom_conversation_receipts").run();
    }
    db.prepare('INSERT OR REPLACE INTO router_state (key, value) VALUES (?, ?)').run('schema_version',String(CURRENT_SCHEMA_VERSION));
  })();`);
 db+=fs.readFileSync(new URL('./conversation-execution-db.fragment',import.meta.url),'utf8');
 db=once(db,'const rows = rawRows.map((r) => normalizeMessageRow(r));','const rows = rawRows.map((r) => normalizeMessageRow(r)).filter(r=>conversationMessageAllowed(r.id,r.chat_jid));');
 const since=db.indexOf('export function getMessagesSince('),end=db.indexOf('type CreateTaskInput',since);
 db=db.slice(0,since)+once(db.slice(since,end),'return rows.map((row) => normalizeMessageRow(row));','return rows.map((row) => normalizeMessageRow(row)).filter(row=>conversationMessageAllowed(row.id,chatJid));')+db.slice(end);
 result.set('db.ts',db);
 const original=name=>native.get(name).toString('utf8').replaceAll('\r\n','\n');
 result.set('group-queue.ts',once(original('group-queue.ts'),'  getActiveQueryId(groupJid: string): string | null {',`  getConversationQueryId(groupJid: string): string | null {
    const state=this.getGroup(groupJid);
    return state.active && state.queryInFlight ? state.queryId : null;
  }
  getActiveQueryId(groupJid: string): string | null {`)); result.set('web.ts',original('web.ts'));
 // N Web dependency matches original N queue contract.
 // No full-host queue or existing gate is mutated.
 let history=original('conversation-history.ts').replace("import { getMessagesPage }", "import { getMessagesPage, conversationMessageAllowed }");
 history=once(history,'.filter((m) => !pendingMessageIds.has(m.id))','.filter((m) => !pendingMessageIds.has(m.id))\n    .filter(m=>conversationMessageAllowed(m.id,chatJid,true))');result.set('conversation-history.ts',history);
 let index=original('index.ts');
 index="import {bindConversationAuthority,listQueuedConversationReceipts,conversationSessionStale,startConversationBatch,finishConversationBatch,noteConversationSession,assertConversationBatchCurrent,cancelConversationReceipt,queueConversationReceipt,readBotConversationReceipt,noteConversationProjection,invalidateConversationProjection} from './db.js';\n"+index;
 index=once(index,'  // Get all messages since last agent interaction',`  if(conversationSessionStale(chatJid)) {
    deleteSession(effectiveGroup.folder); delete sessions[effectiveGroup.folder]; recoveryGroups.add(chatJid);
  }
  // Get all messages since last agent interaction`);
 index=once(index,'    output = await runAgent(\n      effectiveGroup,',`    startConversationBatch(chatJid,missedMessages.map(m=>m.id),queue.getConversationQueryId(chatJid)??undefined,lastProcessed.id);
    output = await runConversationAgent(
      effectiveGroup,`);
 index=index.replaceAll('queryRunId: queue.getActiveQueryId(chatJid) ?? undefined,','queryRunId: queue.getConversationQueryId(chatJid) ?? undefined,');
 index=once(index,'              lastReplyMsgId = replySendOutcome.messageId;',`              if (!holdReason && result.status === 'success' && !result.providerFailure &&
                  result.sourceKind !== 'compact_partial' && result.sourceKind !== 'overflow_partial' &&
                  (!result.finalizationReason || result.finalizationReason === 'completed') && replySendOutcome.messageId) {
                noteConversationProjection(chatJid,queue.getConversationQueryId(chatJid)??undefined,
                  outputChannelScope.inputId,turnIdForDb,replySendOutcome.messageId,dbText);
              }
              lastReplyMsgId = replySendOutcome.messageId;`);
 index=once(index,'        runContainerAgent,\n        group,','        d3Runner,\n        group,');
 index=once(index,`main().catch((err) => {
  logger.error({ err }, 'Failed to start miniclaw');
  process.exit(1);
});`,fs.readFileSync(new URL('./conversation-execution-index.fragment',import.meta.url),'utf8'));
 result.set('index.ts',index);return result;
}
