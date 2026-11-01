import fs from 'node:fs';
import ts from 'typescript';
const prefix='qiwe_legacy_work_preservation:v1:';
const once=(source,before,after)=>{if(source.split(before).length!==2)throw Error('LEGACY_PRESERVATION_ANCHOR_CHANGED:'+before.slice(0,85));return source.replace(before,after);};
function edit(source,name,apply){
 const tree=ts.createSourceFile('candidate.ts',source,ts.ScriptTarget.Latest,true);
 const nodes=tree.statements.filter(node=>ts.isFunctionDeclaration(node)&&node.name?.text===name);
 if(nodes.length!==1||!nodes[0].body)throw Error('LEGACY_PRESERVATION_FUNCTION_CHANGED:'+name);
 const start=nodes[0].getStart(tree),end=nodes[0].end;
 return source.slice(0,start)+apply(source.slice(start,end))+source.slice(end);
}
function guard(source,name,statement){return edit(source,name,body=>{const node=ts.createSourceFile('part.ts',body,ts.ScriptTarget.Latest,true).statements[0];const at=node.body.getStart()+1;return body.slice(0,at)+'\n '+statement+'\n'+body.slice(at);});}
function rewriteSql(source,apply){
 const tree=ts.createSourceFile('sql.ts',source,ts.ScriptTarget.Latest,true),changes=[];
 const visit=node=>{if(ts.isStringLiteral(node)||ts.isNoSubstitutionTemplateLiteral(node)){const next=apply(node.text);if(next!==node.text)changes.push({start:node.getStart(tree),end:node.end,next:JSON.stringify(next)});}ts.forEachChild(node,visit);};visit(tree);
 if(!changes.length)throw Error('LEGACY_PRESERVATION_SQL_ANCHOR_CHANGED');
 for(const change of changes.sort((a,b)=>b.start-a.start))source=source.slice(0,change.start)+change.next+source.slice(change.end);
 return source;
}
const absent=(table,keys)=>`NOT EXISTS (SELECT 1 FROM router_state AS legacy_hold WHERE legacy_hold.key='${prefix}${table}:' || json_array(${keys.join(',')}))`;
const task=absent('scheduled_tasks',['scheduled_tasks.id']);
const run=absent('task_runs',['task_runs.id'])+' AND '+absent('scheduled_tasks',['task_runs.task_id']);
const log=absent('task_run_logs',['task_run_logs.id'])+' AND '+absent('scheduled_tasks',['task_run_logs.task_id']);
const message=absent('messages',['messages.chat_jid','messages.id']);
const execution=absent('wecom_conversation_execution',['wecom_conversation_execution.receipt_id']);
/** Exact full-host source composition; no original tree or business row is mutated. */
export function applyLegacyWorkPreservation(files){
 const result=new Map(files);let db=files.get('db.ts').replaceAll('\r\n','\n');
 db=once(db,'export const CURRENT_SCHEMA_VERSION = 72;','export const CURRENT_SCHEMA_VERSION = 73;');
 db+='\n'+fs.readFileSync(new URL('./legacy-work-preservation-db.fragment',import.meta.url),'utf8');
 for(const name of ['getDueTasks','getDueTaskDefinitionsV2','getNextScheduledTaskWakeAt'])db=edit(db,name,s=>once(s,'WHERE status',`WHERE ${task} AND status`));
 db=guard(db,'claimTaskForRun','if(isLegacyTaskPreserved(id))return false;');
 db=guard(db,'materializeTaskOccurrence','if(isLegacyTaskPreserved(input.taskId))return undefined;');
 db=guard(db,'createTaskRun',"if(isLegacyTaskPreserved(input.task.id))throw Error('LEGACY_WORK_MANUAL_REVIEW_REQUIRED');");
 db=edit(db,'claimTaskRun',s=>once(s,'WHERE (? IS NULL',`WHERE ${run} AND (? IS NULL`));
 db=edit(db,'failExpiredStartedTaskRuns',s=>once(s,"WHERE status = 'running' AND started_at IS NOT NULL",`WHERE ${run} AND status = 'running' AND started_at IS NOT NULL`));
 for(const name of ['claimTaskRunNotification','finalizeExpiredTaskRunNotificationAttempts'])db=edit(db,name,s=>once(s,'WHERE notification_payload IS NOT NULL',`WHERE ${run} AND notification_payload IS NOT NULL`));
 db=edit(db,'getNextTaskRunWakeAt',s=>s.replace(/FROM task_runs\s+WHERE /g,match=>match+run+' AND '));
 db=edit(db,'cleanupStaleRunningLogs',s=>once(s,"WHERE status = 'running'",`WHERE ${log} AND status = 'running'`));
 db=edit(db,'cleanupOldTaskRunLogs',s=>once(once(s,'WHERE run_at < ?',`WHERE ${log} AND run_at < ?`),'WHERE completed_at IS NOT NULL',`WHERE ${run} AND completed_at IS NOT NULL`));
 for(const name of ['markTaskRunExecutionStarted','renewTaskRunLease','releaseTaskRunForRetry','completeTaskRun','cancelTaskRun','updateTaskRunNotification'])db=guard(db,name,'if(isLegacyTaskRunPreserved(id))return false;');
 db=guard(db,'completeIsolatedTaskRunWithWorkspaceResultIntent','if(isLegacyTaskRunPreserved(input.runId))return false;');
 for(const name of ['renewTaskRunNotificationLease','completeTaskRunNotificationAttempt'])db=guard(db,name,'if(isLegacyTaskRunPreserved(claim.runId))return false;');
 db=guard(db,'finalizeTaskRunNotificationIfPending','if(isLegacyTaskRunPreserved(runId))return false;');
 db=guard(db,'conversationMessageAllowed','if(isLegacyMessagePreserved(chatJid,messageId))return false;');
 db=once(db,'type ConversationExecution = {state:ConversationExecutionState;','type ConversationExecution = {manualReviewRequired?:boolean;state:ConversationExecutionState;');
 db=edit(db,'readConversationExecution',s=>once(s,'return {state:row.state,',"return {state:row.state,...(legacyWorkRecordPreserved(db,'wecom_conversation_execution',row)?{manualReviewRequired:true}:{}),"));
 db=edit(db,'claimNextQueuedFollowUp',s=>s.replaceAll("WHERE chat_jid = ?",`WHERE ${message} AND chat_jid = ?`));
 db=guard(db,'transitionFollowUp','if(isLegacyMessagePreserved(chatJid,messageId))return null;');
 for(const name of ['listQueuedConversationReceipts','conversationBatchActive','noteConversationSession','finishConversationBatch'])db=edit(db,name,s=>rewriteSql(s,sql=>sql.replace(/(FROM wecom_conversation_execution|UPDATE wecom_conversation_execution SET .+?) WHERE /g,match=>match+execution+' AND ')));
 db=guard(db,'cancelConversationReceipt',"if(legacyWorkRecordPreserved(db,'wecom_conversation_execution',{receipt_id:receiptId}))return;");
 result.set('db.ts',db);
 result.set('legacy-work-preservation.ts',fs.readFileSync(new URL('./legacy-work-preservation.ts',import.meta.url),'utf8'));
 let scheduler=files.get('task-scheduler.ts').replaceAll('\r\n','\n');
 scheduler="import {isLegacyTaskPreserved,isLegacyTaskRunPreserved} from './db.js';\n"+scheduler;
 scheduler=guard(scheduler,'executeClaimedTaskRun','if(isLegacyTaskRunPreserved(claim.id)||isLegacyTaskPreserved(claim.task_id))return;');
 scheduler=guard(scheduler,'runTask',"if(isLegacyTaskPreserved(staleTask.id))throw Error('LEGACY_WORK_MANUAL_REVIEW_REQUIRED');");
 scheduler=edit(scheduler,'startSchedulerLoop',s=>once(s,'    for (const t of allTasks) {','    for (const t of allTasks) {\n      if(isLegacyTaskPreserved(t.id))continue;'));
 result.set('task-scheduler.ts',scheduler);
 return result;
}
