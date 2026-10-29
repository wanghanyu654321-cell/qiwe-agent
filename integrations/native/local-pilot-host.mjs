import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash,randomUUID} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import ts from 'typescript';
import {DatabaseSync} from 'node:sqlite';
import {snapshotFrontagentState,verifyFrontagentStateBoundary} from './frontagent-product-state.ts';
import {createFullHostCandidate} from './full-host-candidate.mjs';
import {linuxImage,verifyControlledLinuxCopy} from './linux-runtime.mjs';

const project=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../..');
const defaultRoot=path.join(project,'.local/frontagent-product-host-r1-final');
const label='qiwe.local.pilot',port=39130;
const hash=value=>createHash('sha256').update(value).digest('hex');
const validPath=p=>typeof p==='string'&&path.isAbsolute(p)&&path.resolve(p)!==path.parse(path.resolve(p)).root&&!/[\r\n,]/.test(p);
const validId=id=>typeof id==='string'&&/^[a-f0-9-]{36}$/.test(id);
function rejectLinkedPath(target){
 for(let current=path.resolve(target);;current=path.dirname(current)){
  if(fs.existsSync(current)&&fs.lstatSync(current).isSymbolicLink())throw Error('Local pilot linked path refused');
  if(current===path.dirname(current))break;
 }
}
export function parseLocalPilotArguments(args){
 if(args.length===1&&['status','stop'].includes(args[0]))return {command:args[0]};
 if(args.length===7&&args[0]==='start'&&args[1]==='--copy-root'&&args[3]==='--product-root'&&args[5]==='--state-source'&&[args[2],args[4],args[6]].every(validPath))return {command:'start',copyRoot:path.resolve(args[2]),productRoot:path.resolve(args[4]),stateSource:path.resolve(args[6])};
 throw Error('Invalid local pilot arguments: start --copy-root COPY --product-root PRODUCT --state-source ORIGINAL_STATE | status | stop');
}
export function localPilotContainerArguments({root,copyRoot,runId}){
 if(!validPath(root)||!validPath(copyRoot)||!validId(runId)||path.resolve(root)===path.resolve(copyRoot)||path.resolve(copyRoot).startsWith(path.resolve(root)+path.sep))throw Error('Invalid pilot path or run identity');
 return ['--context','desktop-linux','run','--detach','--pull=never','--name=qiwe-local-pilot-'+runId,'--label='+label+'='+runId,
  '--network=none','--read-only','--cap-drop=ALL','--security-opt=no-new-privileges',
  '--pids-limit=256','--memory=4g','--cpus=2','--tmpfs=/tmp:rw,nosuid,nodev,size=768m','--tmpfs=/pilot:rw,nosuid,nodev,size=128m',
  `--mount=type=bind,source=${copyRoot},target=/input,readonly`,`--mount=type=bind,source=${path.join(root,'code')},target=/source,readonly`,`--mount=type=bind,source=${path.join(root,'state')},target=/product-state`,
  '--workdir=/pilot','--env=HOME=/tmp/pilot-home','--env=TMPDIR=/tmp','--env=TZ=Asia/Shanghai','--env=WEB_PORT=3000',
  '--env=MINICLAW_EXECUTION_BOUNDARY=member-container-only','--env=PLUGIN_AUTO_SCAN=false','--env=ALLOW_LEGACY_UNSIGNED_COOKIE=false','--env=TRUST_PROXY=false',
  '--env=CORS_ALLOW_LOCALHOST=false','--env=CORS_ALLOWED_ORIGINS=http://127.0.0.1:'+port,
  '--health-cmd=node -e "fetch(\'http://127.0.0.1:3000/api/auth/status\').then(async r=>{if(!r.ok||typeof (await r.json()).initialized!==\'boolean\')process.exit(1)}).catch(()=>process.exit(1))"',
  '--health-interval=2s','--health-start-period=10s','--health-retries=15','--entrypoint=node',linuxImage,'/source/boot.mjs'];
}
export function localPilotBootSource(){return `import fs from 'node:fs';
import path from 'node:path';
import ts from '/input/qiwe-agent/node_modules/typescript/lib/typescript.js';
import {verifyOriginalLinuxSqlite} from '/input/qiwe-agent/integrations/native/linux-runtime.mjs';
verifyOriginalLinuxSqlite('/input/.local/full-instance/stage/app/src');
fs.mkdirSync('/tmp/pilot-home',{recursive:true});fs.mkdirSync('/tmp/native/src',{recursive:true});
fs.writeFileSync('/tmp/native/package.json','{"type":"module"}');
fs.symlinkSync('/input/.local/full-instance/stage/app/node_modules','/tmp/native/node_modules','dir');
function compile(relative=''){
 for(const e of fs.readdirSync(path.join('/source/src',relative),{withFileTypes:true})){
  const name=path.join(relative,e.name),from=path.join('/source/src',name);
  if(e.isDirectory()){compile(name);continue;}
  if(!e.isFile())throw Error('LOCAL_PILOT_CODE_TYPE');
  const target=path.join('/tmp/native/src',name.replace(/\\.ts$/,'.js'));
  fs.mkdirSync(path.dirname(target),{recursive:true});
  const value=fs.readFileSync(from,'utf8');
  fs.writeFileSync(target,name.endsWith('.ts')?ts.transpileModule(value,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ESNext}}).outputText:value);
 }
}
compile();fs.symlinkSync('/source/web','/pilot/web','dir');fs.symlinkSync('/product-state/runtime/data','/pilot/data','dir');
await import('/tmp/native/src/index.js');
const {getWebDeps}=await import('/tmp/native/src/web-context.js');
for(let i=0;i<200&&!getWebDeps();i++)await new Promise(resolve=>setTimeout(resolve,50));
const localPilotGate=getWebDeps()?.appointmentBootGate;
if(localPilotGate?.phase()!=='paused')throw Error('LOCAL_PILOT_EXPECTED_PAUSED');
const {logger}=await import('/tmp/native/src/logger.js');
logger.info({phase:localPilotGate.phase(),restored:false,businessExecution:'not_started'},'Local pilot Native initialization ready');
`;}
function treeFiles(root){
 const files=[];
 const walk=(relative='')=>{for(const e of fs.readdirSync(path.join(root,relative),{withFileTypes:true})){
  if(e.isSymbolicLink()||!e.isFile()&&!e.isDirectory())throw Error('Local pilot symlink/non-file refused');
  const name=path.join(relative,e.name);if(e.isDirectory())walk(name);else files.push([name.replaceAll('\\','/'),fs.readFileSync(path.join(root,name))]);
 }};walk();return files.sort(([a],[b])=>a.localeCompare(b,'en'));
}
function codeHash(root){return hash(treeFiles(root).map(([name,bytes])=>name+'\0'+hash(bytes)).join('\n'));}
export function frontagentMaintenanceRead(method,pathname){
 return method==='GET'&&['/api/groups','/api/agent-profiles','/api/local-product/config','/api/local-product/drafts','/api/local-product/manager','/api/local-product/training'].includes(pathname);
}
function originalProductWeb(source,ownerId){
 const marker='// --- Route Mounting ---';
 if(source.split(marker).length!==2||source.split('const initializationRead=').length!==2)throw Error('Original product Web anchor changed');
 source=source.replace('const initializationRead=',`const initializationRead=frontagentMaintenanceRead(c.req.method,c.req.path)||`);
 return `import {installFrontagentProductReadRoutes} from '/source/product-web.mjs';
import * as frontagentDb from './db.js';
import * as frontagentModules from '/source/product-modules.mjs';
const frontagentMaintenanceRead=${frontagentMaintenanceRead.toString()};
`+source.replace(marker,`installFrontagentProductReadRoutes(app,{origin:'http://127.0.0.1:${port}',job:'/product-state',ownerId:${JSON.stringify(ownerId)},db:frontagentDb,authMiddleware,productModules:frontagentModules});
`+marker);
}
export async function stageLocalPilot({root=defaultRoot,copyRoot,productRoot,stateSource}){
 if(!validPath(productRoot)||!validPath(stateSource))throw Error('Explicit original product source and state required');

 if(!validPath(root)||!validPath(copyRoot))throw Error('Invalid pilot path');
 if([stateSource,productRoot,copyRoot].some(source=>{const r=path.relative(path.resolve(source),path.resolve(root));return r===''||(!path.isAbsolute(r)&&r!=='..'&&!r.startsWith('..'+path.sep));}))throw Error('Original product and task paths overlap');
 rejectLinkedPath(root);rejectLinkedPath(path.join(root,'state'));
 verifyControlledLinuxCopy(copyRoot);
 const native=path.join(copyRoot,'.local/full-instance/stage/app/src'),overlay=path.join(copyRoot,'.local/core-fix/appointment-identity-candidate/src');
 const candidate=await createFullHostCandidate(native,overlay,{conversationIntake:true,fullHostConversationExecution:true});
 const code=path.join(root,'code'),state=path.join(root,'state');
 if(fs.existsSync(code)||fs.existsSync(state)||fs.existsSync(path.join(root,'host.json')))throw Error('Local product requires a fresh task-owned target');
 for(const p of [productRoot,stateSource])rejectLinkedPath(p);
 const packaged=path.join(productRoot,'deploy/railway/package'),manifestBytes=fs.readFileSync(path.join(packaged,'artifact-manifest.json'));
 if(hash(manifestBytes)!=='b0e02d8aec7144e3dfcc63123534804de34142a0c82a1ea8963aadd15a727204')throw Error('Original product artifact baseline changed');
 const artifacts=JSON.parse(manifestBytes);
 for(const f of artifacts.files)if(hash(fs.readFileSync(path.join(packaged,f.path)))!==f.sha256)throw Error('Original product artifact changed');
 for(const f of artifacts.sources)if(hash(fs.readFileSync(path.resolve(productRoot,f.path)))!==f.sha256)throw Error('Original product source changed');
 fs.mkdirSync(root,{recursive:true});
 const snapshot=await snapshotFrontagentState({sourceRoot:stateSource,targetRoot:state});
 const db=new DatabaseSync(path.join(state,'runtime/data/db/messages.db'),{readOnly:true});let ownerId;
 try{const admins=db.prepare("SELECT id FROM users WHERE role='admin' AND status='active'").all();if(admins.length!==1)throw Error('Original product administrator ambiguous');ownerId=admins[0].id;}finally{db.close();}
 fs.mkdirSync(path.join(code,'src'),{recursive:true});
 candidate.files.set('web.ts',originalProductWeb(candidate.files.get('web.ts'),ownerId));
 for(const [name,value] of candidate.files){const target=path.join(code,'src',name);fs.mkdirSync(path.dirname(target),{recursive:true});fs.writeFileSync(target,value);}
 const originalWeb=path.join(stateSource,'runtime/web');
 if(hash(fs.readFileSync(path.join(originalWeb,'index.html')))!=='b93d1f3f4b5447c518b03d8ccc8a6de4531214eabe6b1e0b1ce302709896d624')throw Error('Original matching product Web changed');
 for(const [name,bytes] of treeFiles(originalWeb)){
  const target=path.join(code,'web/dist',name);fs.mkdirSync(path.dirname(target),{recursive:true});fs.writeFileSync(target,bytes);
 }
 const transpile=source=>ts.transpileModule(source,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ESNext}}).outputText;
 fs.writeFileSync(path.join(code,'package.json'),'{"type":"module"}');
 fs.writeFileSync(path.join(code,'product-web.mjs'),transpile(fs.readFileSync(path.join(project,'integrations/native/frontagent-product-web.ts'),'utf8')));
 const imports=['LocalDraftStore','createManagerService','createTrainingSummaryService'];
 const modules=['local-product','manager-service','training-knowledge'],compiled=new Set();
 function compileProduct(relative){
  if(compiled.has(relative))return;compiled.add(relative);
  const source=path.resolve(productRoot,'src',relative.replace(/\.js$/,'.ts'));
  if(!source.startsWith(path.resolve(productRoot,'src')+path.sep))throw Error('Product module escaped source');
  const text=transpile(fs.readFileSync(source,'utf8')),target=path.join(code,'product',relative);
  fs.mkdirSync(path.dirname(target),{recursive:true});fs.writeFileSync(target,text);
  for(const match of text.matchAll(/(?:from\s*|import\s*)['"](\.[^'"]+\.js)['"]/g))compileProduct(path.join(path.dirname(relative),match[1]));
 }
 modules.forEach(name=>compileProduct('role-eval/'+name+'.js'));
 fs.writeFileSync(path.join(code,'product-modules.mjs'),imports.map((name,i)=>`export {${name}} from './product/role-eval/${modules[i]}.js';`).join('\n'));
 fs.writeFileSync(path.join(code,'boot.mjs'),localPilotBootSource());
 const manifest={version:2,runId:randomUUID(),copyRoot:fs.realpathSync(copyRoot),productRoot:fs.realpathSync(productRoot),stateSource:fs.realpathSync(stateSource),snapshot,codeHash:codeHash(code),nativeTree:candidate.audit.nativeTree,overlayTree:candidate.audit.overlayTree};
 manifest.name='qiwe-local-pilot-'+manifest.runId;
 fs.writeFileSync(path.join(root,'host.json'),JSON.stringify(manifest,null,2)+'\n',{flag:'wx'});
 return manifest;
}
export async function localPilotCommand(input,{root=defaultRoot,execute=spawnSync}={}){
 if(!['start','status','stop'].includes(input.command))throw Error('Invalid local pilot command');
 if(!validPath(root))throw Error('Invalid pilot path');
 rejectLinkedPath(root);rejectLinkedPath(path.join(root,'state'));
 const file=path.join(root,'host.json');
 if(!fs.existsSync(file)&&input.command!=='start')return {state:'not-initialized',restored:false};
 const invoke=(args,timeout=15000)=>{const r=execute('docker',args,{encoding:'utf8',timeout,windowsHide:true});if(r.error)throw r.error;return r;};
 const context=invoke(['context','inspect','desktop-linux','--format','{{.Endpoints.docker.Host}}']);
 if(context.status!==0||context.stdout.trim()!=='npipe:////./pipe/dockerDesktopLinuxEngine')throw Error('Pilot requires local Docker Desktop Linux pipe');
 const m=fs.existsSync(file)?JSON.parse(fs.readFileSync(file,'utf8')):await stageLocalPilot({root,copyRoot:input.copyRoot,productRoot:input.productRoot,stateSource:input.stateSource});
 if(![1,2].includes(m.version)||!validId(m.runId)||m.name!=='qiwe-local-pilot-'+m.runId||!validPath(m.copyRoot))throw Error('Local pilot ownership manifest invalid');
 if(input.command==='start'&&m.version!==2)throw Error('Explicit original product state required; retired empty pilot cannot restart');
 if(input.command==='start'){
  if(![input.copyRoot,input.productRoot,input.stateSource].every(validPath)||path.resolve(input.copyRoot)!==path.resolve(m.copyRoot)||path.resolve(input.productRoot)!==path.resolve(m.productRoot)||path.resolve(input.stateSource)!==path.resolve(m.stateSource))throw Error('Local pilot original product paths mismatch');
  if(m.snapshot?.targetRoot!==path.join(root,'state')||m.snapshot?.sourceRoot!==m.stateSource)throw Error('Local pilot original state manifest mismatch');
  verifyFrontagentStateBoundary({sourceRoot:m.stateSource,targetRoot:path.join(root,'state')});
  const database=path.join(root,'state/runtime/data/db/messages.db');
  if(!fs.existsSync(database))throw Error('Original product state database missing');
  const existing=new DatabaseSync(database,{readOnly:true});try{if(!existing.prepare("SELECT COUNT(*) AS n FROM users WHERE role='admin' AND status='active'").get().n)throw Error('Original product state administrator missing');}finally{existing.close();}
 }

 const inspect=()=>{
  const r=invoke(['--context','desktop-linux','inspect','--type=container','--format','{"name":{{json .Name}},"id":{{json .Id}},"running":{{json .State.Running}},"health":{{json .State.Health.Status}},"labels":{{json .Config.Labels}}}',m.name]);
  if(r.status!==0){if(/No such (?:object|container)/i.test(r.stderr??''))return null;throw Error('Local pilot container state unknown');}
  const v=JSON.parse(r.stdout);if(v.name!=='/'+m.name||v.labels?.[label]!==m.runId||typeof v.id!=='string'||!/^[a-f0-9]{64}$/.test(v.id))throw Error('Local pilot container ownership mismatch');return v;
 };
 let state=inspect();
 if(input.command==='status')return {state:state?.running?'running':state?'stopped':'not-created',health:state?.health??null,url:null,access:'container-loopback-only',data:path.join(root,m.version===2?'state':'data'),restored:false};
 if(input.command==='stop'){
  if(state?.running){const stopped=invoke(['--context','desktop-linux','stop','--time=35',state.id],45000);if(stopped.status!==0)throw Error('Local pilot stop failed');}
  return {state:'stopped',data:path.join(root,m.version===2?'state':'data'),restored:false};
 }
 verifyControlledLinuxCopy(m.copyRoot);
 if(codeHash(path.join(root,'code'))!==m.codeHash)throw Error('Local pilot code changed');
 if(!state){
  const started=invoke(localPilotContainerArguments({root,copyRoot:m.copyRoot,runId:m.runId}),30000);if(started.status!==0)throw Error('Local pilot start failed');
 }else if(!state.running){const started=invoke(['--context','desktop-linux','start',state.id],30000);if(started.status!==0)throw Error('Local pilot start failed');}
 state=inspect();
 return {state:state?.running?'running':'not-running',health:state?.health??'starting',url:null,access:'container-loopback-only',data:path.join(root,m.version===2?'state':'data'),restored:false,scope:'Existing Frontagent login and exact maintenance reads; execution remains paused'};
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 try{console.log(JSON.stringify(await localPilotCommand(parseLocalPilotArguments(process.argv.slice(2))),null,2));}catch(e){console.error(e instanceof Error?e.message:'Local pilot failed');process.exitCode=1;}
}
