import {createHash} from 'node:crypto';
import path from 'node:path';
import fs from 'node:fs';

export const digest=(value:unknown)=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
export const adminId='restoration-admin',sessionId='e'.repeat(64);
export const memberSessionId='f'.repeat(64);
export const actor={tenantId:'restoration-tenant',accountId:'restoration-member',storeId:'restoration-store',corpId:'restoration-corp',botId:'restoration-bot',memberId:'restoration-subject',bindingVersion:1,grantVersion:1};
export const business={tenant:actor.tenantId,store:actor.storeId,workspace:'web:restoration-business'};
export const employee={accountId:actor.accountId,employeeId:'restoration-employee',employeeName:'Synthetic employee'};
export const staff={...business,employeeId:employee.employeeId,employeeName:employee.employeeName};
export const workspaceJid='web:restoration-role',folder=process.env.QIWE_RESTORATION_REAL_CONTAINER==='1'?'synthetic-restoration-role':'restoration-role',profileId='restoration-marketing-profile';
export const roleKey=digest([actor.tenantId,actor.accountId,actor.storeId,'marketing']);
export const receiptId=(origin:string)=>digest([actor.corpId,actor.botId,actor.memberId,origin]);
export const completedContent='合成历史答案：本内容来自原始D5持久化结果。';
export const oldTaskId='restoration-old-task';
export const factFile=(dataDir:string)=>path.join(dataDir,'restoration-facts.sqlite');
export const grantFile=(dataDir:string)=>path.join(dataDir,'restoration-grants.sqlite');
export const seedEvidenceFile=()=>process.env.QIWE_RESTORATION_SEED_EVIDENCE??path.join(process.cwd(),'restoration-seed.json');
export function readSeed(){return JSON.parse(fs.readFileSync(seedEvidenceFile(),'utf8'));}
export function retainedSnapshot(sql:any){return {
 task:sql.prepare('SELECT * FROM scheduled_tasks WHERE id=?').get(oldTaskId),
 runs:sql.prepare('SELECT * FROM task_runs WHERE task_id=? ORDER BY id').all(oldTaskId),
 messages:sql.prepare('SELECT * FROM messages WHERE chat_jid=? AND id IN (SELECT message_id FROM wecom_conversation_receipts WHERE origin_message_id LIKE ?) ORDER BY id').all(workspaceJid,'restoration-old-%'),
 executions:sql.prepare('SELECT * FROM wecom_conversation_execution WHERE receipt_id IN (SELECT receipt_id FROM wecom_conversation_receipts WHERE origin_message_id LIKE ?) ORDER BY receipt_id').all('restoration-old-%'),
 results:sql.prepare('SELECT * FROM wecom_conversation_results WHERE receipt_id=? ORDER BY revision').all(receiptId('restoration-old-completed')),
};}
