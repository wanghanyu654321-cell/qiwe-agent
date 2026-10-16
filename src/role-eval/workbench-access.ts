import {DatabaseSync} from 'node:sqlite';
import {createHash} from 'node:crypto';

export const WORKBENCH_ROLES=['reception','frontdesk','marketing','ads','manager','qa','training'] as const;
export type WorkbenchRole=typeof WORKBENCH_ROLES[number];
export interface WorkbenchGrant {accountId:string;storeId:string;roles:WorkbenchRole[];version:number;active:boolean;updatedBy:string;}
export interface GrantChange {accountId:string;storeId:string;roles:WorkbenchRole[];active:boolean;expectedVersion:number;requestKey:string;}
export class WorkbenchAccessStore {
 private db:DatabaseSync;
 constructor(file:string){this.db=new DatabaseSync(file);this.db.exec('PRAGMA journal_mode=WAL; PRAGMA busy_timeout=3000; CREATE TABLE IF NOT EXISTS workbench_grants(account TEXT PRIMARY KEY, body TEXT NOT NULL); CREATE TABLE IF NOT EXISTS workbench_grant_changes(request TEXT PRIMARY KEY, fingerprint TEXT NOT NULL, body TEXT NOT NULL);');}
 bindTenant(tenantId:string):void {
  if(!tenantId||tenantId.length>120||/[\s\u0000]/.test(tenantId))throw Error('invalid_access_tenant');
  this.db.exec('CREATE TABLE IF NOT EXISTS workbench_access_tenant(singleton INTEGER PRIMARY KEY CHECK(singleton=1),tenant TEXT NOT NULL);');
  this.db.prepare('INSERT OR IGNORE INTO workbench_access_tenant VALUES (1,?)').run(tenantId);
  const row=this.db.prepare('SELECT tenant FROM workbench_access_tenant WHERE singleton=1').get() as {tenant:string};if(row.tenant!==tenantId)throw Error('access_tenant_conflict');
 }
 get(account:string):WorkbenchGrant|undefined {const r=this.db.prepare('SELECT body FROM workbench_grants WHERE account=?').get(account) as {body:string}|undefined;return r?JSON.parse(r.body):undefined;}
 list():WorkbenchGrant[]{return (this.db.prepare('SELECT body FROM workbench_grants ORDER BY account').all() as {body:string}[]).map(r=>JSON.parse(r.body));}
 /** Synchronous business commits and grant revocation serialize across processes. */
 withCurrent<T>(grant:WorkbenchGrant,work:()=>T):T {
  this.db.exec('BEGIN IMMEDIATE');try{const current=this.get(grant.accountId);if(!current?.active||current.version!==grant.version||current.storeId!==grant.storeId)throw Error('access_changed');const result=work();this.db.exec('COMMIT');return result;}catch(error){this.db.exec('ROLLBACK');throw error;}
 }
 change(actor:string,input:GrantChange):WorkbenchGrant {
  const id=(v:unknown)=>typeof v==='string'&&v.length>0&&v.length<=120&&!/[\s\u0000]/.test(v);
  if(!id(actor)||!input||typeof input!=='object'||Array.isArray(input)||Object.keys(input).some(k=>!['accountId','storeId','roles','active','expectedVersion','requestKey'].includes(k))||!id(input.accountId)||!id(input.storeId)||typeof input.requestKey!=='string'||! /^[A-Za-z0-9-]{1,80}$/.test(input.requestKey)||typeof input.active!=='boolean'||!Number.isSafeInteger(input.expectedVersion)||input.expectedVersion<0||input.expectedVersion>=Number.MAX_SAFE_INTEGER||!Array.isArray(input.roles)||input.roles.length>7||input.active&&input.roles.length===0||input.roles.some(r=>!WORKBENCH_ROLES.includes(r))||new Set(input.roles).size!==input.roles.length)throw Error('invalid_grant');
  const roles=[...input.roles].sort(),fingerprint=createHash('sha256').update(JSON.stringify([actor,input.accountId,input.storeId,roles,input.active,input.expectedVersion])).digest('hex');
  this.db.exec('BEGIN IMMEDIATE');try{
   const old=this.db.prepare('SELECT fingerprint,body FROM workbench_grant_changes WHERE request=?').get(input.requestKey) as {fingerprint:string;body:string}|undefined;
   if(old){if(old.fingerprint!==fingerprint)throw Error('grant_request_conflict');this.db.exec('COMMIT');return JSON.parse(old.body);}
   if((this.get(input.accountId)?.version??0)!==input.expectedVersion)throw Error('grant_version_conflict');
   const next:WorkbenchGrant={accountId:input.accountId,storeId:input.storeId,roles,active:input.active,version:input.expectedVersion+1,updatedBy:actor},body=JSON.stringify(next);
   this.db.prepare('INSERT INTO workbench_grants VALUES (?,?) ON CONFLICT(account) DO UPDATE SET body=excluded.body').run(input.accountId,body);
   this.db.prepare('INSERT INTO workbench_grant_changes VALUES (?,?,?)').run(input.requestKey,fingerprint,body);this.db.exec('COMMIT');return next;
  }catch(error){this.db.exec('ROLLBACK');throw error;}
 }
 close(){this.db.close();}
}
