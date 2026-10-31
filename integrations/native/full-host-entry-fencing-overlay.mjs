import ts from 'typescript';
import {createHash} from 'node:crypto';

function once(source,before,after){
 if(source.split(before).length!==2)throw Error('FULL_HOST_ENTRY_ANCHOR_CHANGED:'+before.slice(0,60));
 return source.replace(before,after);
}
function wrapBodies(source,name,select,body){
 const parsed=ts.createSourceFile(name,source,ts.ScriptTarget.Latest,true),matches=[];
 function walk(node){if(select(node,parsed))matches.push(node);ts.forEachChild(node,walk);}
 walk(parsed);
 if(matches.length!==1)throw Error('FULL_HOST_ENTRY_CALLBACK_CHANGED:'+name);
 const node=matches[0];return source.slice(0,node.getStart(parsed))+body(node.getText(parsed))+source.slice(node.end);
}
const guardBody=(text,ticket,denied)=>`{
 const entryGate=APPOINTMENT_BOOT_BOUNDARY==='member-container-only'?deps?.appointmentBootGate:undefined;
 if(APPOINTMENT_BOOT_BOUNDARY==='member-container-only'&&(!entryGate||entryGate.isPaused())){${denied}return;}
 const ${ticket}=entryGate?.beginWrite();
 if(${ticket}===null){entryGate?.noteArrival();${denied}return;}
 try {${text.slice(1,-1)}} finally {if(entryGate&&${ticket})entryGate.finishWrite(${ticket});}
}`;

/** The complete candidate alone fences the original Web entry points. No
 * handler, permission rule, business transaction or recovery route is replaced. */
export function applyFullHostEntryFencing(files){
 const result=new Map(files);
 let web=result.get('web.ts');
 web=once(web,'// --- Route Mounting ---',`// Full-host maintenance must precede auth middleware (which itself writes
// session activity), including routes that appear to be read-only.
app.use('/api/*',async(c,next)=>{
 if(c.req.path==='/api/appointment/maintenance'||c.req.path.startsWith('/api/appointment/maintenance/'))return next();
 if(APPOINTMENT_BOOT_BOUNDARY!=='member-container-only')return next();
 const gate=deps?.appointmentBootGate;
 // Existing administrators still need to log in before requesting recovery.
 // Login writes participate in review invalidation just like all other writes.
 const recoveryLogin=c.req.path==='/api/auth/login'&&c.req.method==='POST';
 const initializationSetup=c.req.path==='/api/auth/setup'&&c.req.method==='POST';
 const initializationRead=c.req.method==='GET'&&['/api/auth/status','/api/auth/register/status','/api/auth/me'].includes(c.req.path);
 // Only the original empty-users setup may create the local administrator.
 // A missing/foreign Origin cannot use this unauthenticated initialization path.
 if(initializationSetup){
  const setupOrigins=CORS_ALLOWED_ORIGINS.split(',').map(value=>value.trim()).filter(Boolean);
  const explicitOrigins=setupOrigins.length>0&&!setupOrigins.includes('*');
  let sameOrigin=false;try{
   const origin=c.req.header('origin');
   sameOrigin=origin===new URL(c.req.url).origin&&(!explicitOrigins||setupOrigins.includes(origin));
  }catch{}
  if(!sameOrigin)return c.json({error:'invalid_origin'},403);
 }
 if(!gate||gate.isPaused()&&!recoveryLogin&&!initializationSetup&&!initializationRead)return c.json(appointmentBootMaintenanceResponse,503);
 const fullHostHttpTicket=gate.beginWrite();
 if(!fullHostHttpTicket){gate.noteArrival();return c.json(appointmentBootMaintenanceResponse,503);}
 try {await next();} finally {gate.finishWrite(fullHostHttpTicket);}
});

// --- Route Mounting ---`);
 for(const event of ['upgrade','message']){
  web=wrapBodies(web,'web.ts:'+event,(node,p)=>ts.isBlock(node)&&ts.isArrowFunction(node.parent)&&
   ts.isCallExpression(node.parent.parent)&&node.parent.parent.expression.getText(p)===(event==='upgrade'?'server.on':'ws.on')&&
   node.parent.parent.arguments[0]?.getText(p)===`'${event}'`,
   text=>guardBody(text,event==='upgrade'?'fullHostUpgradeTicket':'fullHostSocketTicket',event==='upgrade'?
    `socket.write('HTTP/1.1 503 Service Unavailable\\r\\nConnection: close\\r\\nContent-Length: 0\\r\\n\\r\\n');socket.destroy();`:
    `ws.send(JSON.stringify({type:'ws_error',code:'APPOINTMENT_MAINTENANCE',accepted:false,error:appointmentBootMaintenanceResponse.error}));`));
 }
 result.set('web.ts',web);
 let index=result.get('index.ts');
 for(const marker of ['archiveInactiveConversationAgents','cleanupChannelReliability']){
  index=wrapBodies(index,'index.ts:'+marker,(node,p)=>ts.isBlock(node)&&ts.isArrowFunction(node.parent)&&
   node.getText(p).includes(marker)&&node.getText(p).includes('appointmentBootGate.isPaused()'),text=>`{
    if(appointmentBootGate.isPaused())return;
    const fullHostCleanupTicket=appointmentBootGate.beginWrite();if(!fullHostCleanupTicket)return;
    try {${text.slice(1,-1)}}finally{appointmentBootGate.finishWrite(fullHostCleanupTicket);}
   }`);
 }
 result.set('index.ts',index);
 let inline=result.get('plugin-inline-bash.ts');
 inline="import { BUSINESS_EXECUTION_BOUNDARY, BUSINESS_EXECUTION_ERROR_PREFIX, evaluateExecution } from './business-execution-policy.js';\n"+inline;
 inline=wrapBodies(inline,'plugin-inline-bash.ts:executeInlineBashHost',(node)=>ts.isBlock(node)&&
  ts.isFunctionDeclaration(node.parent)&&node.parent.name?.text==='executeInlineBashHost',text=>`{
 const fullHostInlineAdmission=evaluateExecution(BUSINESS_EXECUTION_BOUNDARY,'host-inline',null);
 if(!fullHostInlineAdmission.allowed)return {ok:false,stdout:'',stderr:BUSINESS_EXECUTION_ERROR_PREFIX+'host-inline',exitCode:null,signal:null,timedOut:false};
 ${text.slice(1,-1)}}`);
 result.set('plugin-inline-bash.ts',inline);
 return result;
}

/** Build-time compatibility check for the specifically audited complete-host
 * entry closure. Runtime lifecycle and physical boundary are separate checks. */
export function assertFullHostWriterCoverage(files){
 const required={
  'web.ts':['fullHostHttpTicket','fullHostUpgradeTicket','fullHostSocketTicket'],
  'index.ts':['appointmentMaintenanceTicket','fullHostCleanupTicket','appointmentStartupTicket','appointmentConsumerTicket','appointmentExecutionDrain'],
  'task-scheduler.ts':['assertClaimCurrent?.()','appointmentTaskPaused(deps)','appointmentTicket'],
  'group-queue.ts':['appointmentBootGate.beginWrite()','appointmentBootGate.finishWrite('],
  'plugin-inline-bash.ts':["const fullHostInlineAdmission=evaluateExecution(BUSINESS_EXECUTION_BOUNDARY,'host-inline',null);", "if(!fullHostInlineAdmission.allowed)return {ok:false,stdout:'',stderr:BUSINESS_EXECUTION_ERROR_PREFIX+'host-inline',exitCode:null,signal:null,timedOut:false};"],
  'container-runner.ts':["if (BUSINESS_EXECUTION_BOUNDARY !== 'original') return appointmentColdDenied();"],
  'script-runner.ts':["if (APPOINTMENT_TASK_BOUNDARY === 'member-container-only')", "throw new Error(BUSINESS_EXECUTION_ERROR_PREFIX + 'script');"],
  'appointment-cold-admission.ts':['if (input.isAdminHome || input.isMain || !validSessionNamespace(input))'],
 };
 const evidence={};
 for(const [name,markers]of Object.entries(required)){
  const source=files.get(name);if(!source||markers.some(marker=>!source.includes(marker)))throw Error('FULL_HOST_WRITER_COVERAGE_CHANGED:'+name);
  evidence[name]=createHash('sha256').update(source).digest('hex');
 }
 const inline=files.get('plugin-inline-bash.ts'),parsed=ts.createSourceFile('plugin-inline-bash.ts',inline,ts.ScriptTarget.Latest,true);
 const host=parsed.statements.find(node=>ts.isFunctionDeclaration(node)&&node.name?.text==='executeInlineBashHost');
 if(!host?.body||host.body.statements[0]?.getText(parsed)!==required['plugin-inline-bash.ts'][0]||
  host.body.statements[1]?.getText(parsed)!==required['plugin-inline-bash.ts'][1])throw Error('FULL_HOST_INLINE_FENCE_MOVED');
 return evidence;
}
