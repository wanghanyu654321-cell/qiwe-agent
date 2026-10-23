import ts from 'typescript';

function editFunction(source,name,apply){
 const tree=ts.createSourceFile('authority.ts',source,ts.ScriptTarget.Latest,true),found=[];
 function visit(node){if(ts.isFunctionDeclaration(node)&&node.name?.text===name)found.push(node);ts.forEachChild(node,visit);}visit(tree);
 if(found.length!==1)throw Error('FULL_HOST_AUTHORITY_FUNCTION_CHANGED:'+name);
 const node=found[0],start=node.getStart(tree),end=node.end;
 return source.slice(0,start)+apply(source.slice(start,end))+source.slice(end);
}
const once=(source,before,after)=>{if(source.split(before).length!==2)throw Error('FULL_HOST_AUTHORITY_ANCHOR_CHANGED');return source.replace(before,after);};

/** The existing administrator's host recovery authority is independent from
 * access to employee content. Selected content routes keep their original ACL. */
export function applyFullHostRecoveryAuthority(files){
 if(!files.has('full-host-restoration-context.ts')||!files.has('legacy-work-preservation.ts'))throw Error('FULL_HOST_AUTHORITY_RESTORATION_REQUIRED');
 const result=new Map(files);
 let http=files.get('appointment-boot-http.ts').replaceAll('\r\n','\n');
 http=editFunction(http,'snapshot',source=>once(once(source,
  'const principal = getAppointmentRestorePrincipal(who);','getAppointmentRestorePrincipal(who);'),
  'if (!group || !canAccessGroup(principal, { ...group, jid }))','if (!group)'));
 result.set('appointment-boot-http.ts',http);
 let index=files.get('index.ts');
 if(index.includes('preserveFullHostLegacyWork'))throw Error('FULL_HOST_AUTHORITY_ALREADY_APPLIED');
 const imports=`import { getAppointmentRestorePrincipal as fullHostRestorePrincipal,
  inspectLegacyTaskPreservation, inspectLegacyMessagePreservation,
  preserveLegacyTask, preserveLegacyMessage } from './db.js';
import type { TrustedRequestIdentity as FullHostRecoveryIdentity } from './appointment-current-identity.js';
import { verifyCurrentLocalBoundary } from './full-host-restoration-context.js';
`;
 index=once(index,"import './load-env.js';","import './load-env.js';\n"+imports)+`
type FullHostLegacySelection={kind:'task';taskId:string}|{kind:'message';chatJid:string;messageId:string};
function withFullHostLegacyMaintenance<T>(who:FullHostRecoveryIdentity,action:()=>T):T {
 fullHostRestorePrincipal(who);
 if(APPOINTMENT_BOOT_BOUNDARY!=='member-container-only'||appointmentBootGate.phase()!=='paused')throw Error('FULL_HOST_LEGACY_MAINTENANCE_REQUIRED');
 const ticket=appointmentBootGate.beginWrite();
 if(!ticket)throw Error('FULL_HOST_LEGACY_MAINTENANCE_BUSY');
 try {
  // Pinned local supervisor, actual process exit and namespaces. No JSON safety claim.
  verifyCurrentLocalBoundary();
  fullHostRestorePrincipal(who);
  return action();
 }finally{appointmentBootGate.finishWrite(ticket);}
}
export function inspectFullHostLegacyWork(who:FullHostRecoveryIdentity,selection:FullHostLegacySelection){
 return withFullHostLegacyMaintenance(who,()=>{
  if(!selection||!['task','message'].includes(selection.kind))throw Error('LEGACY_PRESERVATION_INVALID_SELECTION');
  const snapshot=selection.kind==='task'?inspectLegacyTaskPreservation(selection.taskId):inspectLegacyMessagePreservation(selection.chatJid,selection.messageId);
  return {version:snapshot.version,records:snapshot.records.map(({table,keys})=>({table,keys}))};
 });
}
export function preserveFullHostLegacyWork(who:FullHostRecoveryIdentity,selection:FullHostLegacySelection,expectedVersion:string){
 return withFullHostLegacyMaintenance(who,()=>{
  if(!selection||!['task','message'].includes(selection.kind))throw Error('LEGACY_PRESERVATION_INVALID_SELECTION');
  return selection.kind==='task'?preserveLegacyTask(selection.taskId,expectedVersion):preserveLegacyMessage(selection.chatJid,selection.messageId,expectedVersion);
 });
}
`;
 result.set('index.ts',index);
 return result;
}
