import fs from 'node:fs';
const once=(source,before,after)=>{if(source.split(before).length!==2)throw Error('D3_ANCHOR_CHANGED: '+before.slice(0,100));return source.replace(before,after);};
export function applyConversationExecution(files,native,{fullHost=false}={}){
 if(typeof fullHost!=='boolean')throw Error('D3_INVALID_FULL_HOST_SCOPE');
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
 if(fullHost){
  // O owns interrupted-work recovery. Binding trusted authorization during
  // maintenance is configuration, never permission to settle old execution.
  db=once(db,` db.exec("UPDATE wecom_conversation_execution SET state='unknown' WHERE state IN ('running','cancelling')");`, ' // Interrupted rows remain for original O maintenance review.');
  db=once(db,`    if(Number(rawSchemaVersionBeforeInit??0)<71) {
      db.prepare("INSERT OR IGNORE INTO wecom_conversation_execution(receipt_id,workspace_jid,message_id,state) SELECT receipt_id,workspace_jid,message_id,'queued' FROM wecom_conversation_receipts").run();
    }`, '    // Do not convert legacy receipts into executable work during O startup.');
  db+=`\nexport function conversationBatchActive(chatJid:string,queryId:string):boolean {
 return !!db.prepare("SELECT 1 FROM wecom_conversation_execution WHERE workspace_jid=? AND query_id=? AND state IN ('running','cancelling') LIMIT 1").get(chatJid,queryId);
}\n`;
 }
 db=once(db,'const rows = rawRows.map((r) => normalizeMessageRow(r));','const rows = rawRows.map((r) => normalizeMessageRow(r)).filter(r=>conversationMessageAllowed(r.id,r.chat_jid));');
 const since=db.indexOf('export function getMessagesSince('),end=db.indexOf('type CreateTaskInput',since);
 db=db.slice(0,since)+once(db.slice(since,end),'return rows.map((row) => normalizeMessageRow(row));','return rows.map((row) => normalizeMessageRow(row)).filter(row=>conversationMessageAllowed(row.id,chatJid));')+db.slice(end);
 result.set('db.ts',db);
 const original=name=>(fullHost?files.get(name):native.get(name).toString('utf8')).replaceAll('\r\n','\n');
 result.set('group-queue.ts',once(original('group-queue.ts'),'  getActiveQueryId(groupJid: string): string | null {',`  getConversationQueryId(groupJid: string): string | null {
    const state=this.getGroup(groupJid);
    return state.active && state.queryInFlight ? state.queryId : null;
  }
  getActiveQueryId(groupJid: string): string | null {`)); if(!fullHost)result.set('web.ts',original('web.ts'));
 // Legacy D3 retains N Web/queue compatibility. Full-host mode preserves O's
 // existing Web and queue gate and only adds a query-identity alias.
 let history=original('conversation-history.ts').replace("import { getMessagesPage }", "import { getMessagesPage, conversationMessageAllowed }");
 history=once(history,'.filter((m) => !pendingMessageIds.has(m.id))','.filter((m) => !pendingMessageIds.has(m.id))\n    .filter(m=>conversationMessageAllowed(m.id,chatJid,true))');result.set('conversation-history.ts',history);
 let index=original('index.ts');
 const imports="import {bindConversationAuthority,listQueuedConversationReceipts,conversationSessionStale,startConversationBatch,finishConversationBatch,noteConversationSession,assertConversationBatchCurrent,cancelConversationReceipt,queueConversationReceipt,readBotConversationReceipt,noteConversationProjection,invalidateConversationProjection} from './db.js';\n";
 index=fullHost?once(index,"import './load-env.js';","import './load-env.js';\nimport {conversationBatchActive} from './db.js';\n"+imports):imports+index;
 index=once(index,'  // Get all messages since last agent interaction',`  if(conversationSessionStale(chatJid)) {
    deleteSession(effectiveGroup.folder); delete sessions[effectiveGroup.folder]; recoveryGroups.add(chatJid);
  }
  // Get all messages since last agent interaction`);
 index=once(index,'    output = await runAgent(\n      effectiveGroup,',`    startConversationBatch(chatJid,missedMessages.map(m=>m.id),queue.getConversationQueryId(chatJid)??undefined,lastProcessed.id);
    output = await runConversationAgent(
      effectiveGroup,`);
 if(fullHost)index=once(index,'    startConversationBatch(chatJid,missedMessages.map(m=>m.id),queue.getConversationQueryId(chatJid)??undefined,lastProcessed.id);',`    const conversationBatchQueryId=queue.getConversationQueryId(chatJid)??undefined;
    startConversationBatch(chatJid,missedMessages.map(m=>m.id),conversationBatchQueryId,lastProcessed.id);`);
 index=index.replaceAll('queryRunId: queue.getActiveQueryId(chatJid) ?? undefined,','queryRunId: queue.getConversationQueryId(chatJid) ?? undefined,');
 index=once(index,'              lastReplyMsgId = replySendOutcome.messageId;',`              if (!holdReason && result.status === 'success' && !result.providerFailure &&
                  result.sourceKind !== 'compact_partial' && result.sourceKind !== 'overflow_partial' &&
                  (!result.finalizationReason || result.finalizationReason === 'completed') && replySendOutcome.messageId) {
                noteConversationProjection(chatJid,queue.getConversationQueryId(chatJid)??undefined,
                  outputChannelScope.inputId,turnIdForDb,replySendOutcome.messageId,dbText);
              }
              lastReplyMsgId = replySendOutcome.messageId;`);
 if(fullHost)index=once(index,'noteConversationProjection(chatJid,queue.getConversationQueryId(chatJid)??undefined,','noteConversationProjection(chatJid,conversationBatchQueryId,');
 index=once(index,'        runContainerAgent,\n        group,','        d3Runner,\n        group,');
 const main=`main().catch((err) => {
  logger.error({ err }, 'Failed to start miniclaw');
  process.exit(1);
});`;
 let fragment=fs.readFileSync(new URL('./conversation-execution-index.fragment',import.meta.url),'utf8');
 if(fullHost){
  // Reuse the existing D3/D5 observation and canonical result lifecycle. The
  // full host keeps its real runner; no test-runner binding is admitted.
  fragment=fragment.replaceAll('\r\n','\n');
  fragment=fragment.slice(fragment.indexOf('let d5OnCompleted:'),fragment.indexOf('export function initializeIsolatedConversationExecution'));
  fragment=fragment.replace(" if(!d3TerminalRunner||!input.queryRunId||!input.turnId)throw Error('D3_NOT_BOUND');"," if(!input.queryRunId||!input.turnId)throw Error('D3_NOT_BOUND');");
  fragment=fragment.replace(" if(!input.queryRunId||!input.turnId)throw Error('D3_NOT_BOUND');",` if(!input.queryRunId||!conversationBatchActive(input.chatJid,input.queryRunId))return runContainerAgent(group,input,onProcess,onOutput,ownerHomeFolder);
 if(!input.turnId)throw Error('D3_NOT_BOUND');`);
  fragment=fragment.replace('await d3TerminalRunner(group,input,','await runContainerAgent(group,input,');
  // A real O runner may stay alive for subsequent Web warm turns. Those
  // callbacks still belong to O's original onOutput, never to this first
  // conversation receipt's projection, session or terminal result.
  fragment=once(fragment,' let interrupted=false,completed=false;',` let interrupted=false,completed=false;
 let runnerSettled=false;
 let initialOutput:Awaited<ReturnType<typeof runContainerAgent>>|undefined;
 const ownsInitial=(event:Awaited<ReturnType<typeof runContainerAgent>>)=>{
  const supplied=[event.turnId,event.inputTurnId,event.streamEvent?.turnId].filter(id=>id!==undefined);
  return supplied.length>0&&supplied.every(id=>id===initialTurnId);
 };`);
  fragment=once(fragment,'   if(unhealthy||!!event.result&&!event.inputTurnCompleted)',`   if(event.status!=='stream'||event.inputTurnCompleted||unhealthy)initialOutput=event;
   if(unhealthy||!!event.result&&!event.inputTurnCompleted)`);
  fragment=once(fragment,'   observe(event);','   if(runnerSettled)return;\n   if(ownsInitial(event)){\n   observe(event);');
  fragment=once(fragment,'   await onOutput?.(event);','   }\n   await onOutput?.(event);');
  fragment=once(fragment,`  observe(output);
  const frozen=finishConversationBatch(input.chatJid,queryId,interrupted?'cancelled':output.status==='success'&&completed?'completed':output.status==='error'?'failed':'unknown',output.status==='success'?output.newSessionId:undefined);`,`  runnerSettled=true;
  if(ownsInitial(output))observe(output);
  const own=initialOutput;
  const frozen=finishConversationBatch(input.chatJid,queryId,interrupted?'cancelled':own?.status==='success'&&completed?'completed':own?.status==='error'?'failed':'unknown',own?.status==='success'?own.newSessionId:undefined);`);
  fragment=once(fragment," }catch(error){finishConversationBatch(input.chatJid,queryId,'unknown');throw error;}"," }catch(error){runnerSettled=true;finishConversationBatch(input.chatJid,queryId,'unknown');throw error;}");
  fragment+=fs.readFileSync(new URL('./full-host-conversation-index.fragment',import.meta.url),'utf8');
 }
 index=once(index,main,fragment+(fullHost?'\n'+main:''));
 result.set('index.ts',index);return result;
}
