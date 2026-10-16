import type {WorkbenchAccessStore,WorkbenchRole} from './workbench-access.js';
import type {WorkbenchAccessContext} from './workbench-opening.js';
export interface WorkbenchAuthorityCatalog {tenantId:string;stores:readonly {id:string}[];roles:readonly WorkbenchRole[];store:WorkbenchAccessStore;}
export function resolveWorkbenchAuthority(catalog:WorkbenchAuthorityCatalog,nativeUser:unknown,workspaceJid:string):WorkbenchAccessContext {
 const u=nativeUser as Record<string,unknown>|null;
 if(!u||typeof u.id!=='string'||!u.id||!['admin','member'].includes(String(u.role))||u.status!=='active'||u.must_change_password!==false)throw Error('access_denied');
 const grant=catalog.store.get(u.id);
 if(!grant?.active||!catalog.stores.some(s=>s.id===grant.storeId)||grant.roles.some(r=>!catalog.roles.includes(r)))throw Error('access_not_open');
 if(!workspaceJid.startsWith('web:')||workspaceJid.length>200||/[\s\u0000#]/.test(workspaceJid))throw Error('access_home_unavailable');
 return {identity:{accountId:u.id,workspaceJid,tenantId:catalog.tenantId,storeId:grant.storeId,grantVersion:grant.version},grant};
}
