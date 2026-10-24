import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash,randomUUID} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {createFullHostCandidate} from './full-host-candidate.mjs';
import {linuxImage,verifyControlledLinuxCopy} from './linux-runtime.mjs';

const project=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../..');
const defaultRoot=path.join(project,'.local/local-pilot-host');
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
 if(args.length===3&&args[0]==='start'&&args[1]==='--copy-root'&&validPath(args[2]))return {command:'start',copyRoot:path.resolve(args[2])};
 throw Error('Invalid local pilot arguments: start --copy-root ABSOLUTE_CONTROLLED_COPY | status | stop');
}
export function localPilotContainerArguments({root,copyRoot,runId}){
 if(!validPath(root)||!validPath(copyRoot)||!validId(runId)||path.resolve(root)===path.resolve(copyRoot)||path.resolve(copyRoot).startsWith(path.resolve(root)+path.sep))throw Error('Invalid pilot path or run identity');
 return ['--context','desktop-linux','run','--detach','--pull=never','--name=qiwe-local-pilot-'+runId,'--label='+label+'='+runId,
  '--network=qiwe-local-pilot-'+runId+'-web','--publish=127.0.0.1:'+port+':3000','--read-only','--cap-drop=ALL','--security-opt=no-new-privileges',
  '--pids-limit=256','--memory=4g','--cpus=2','--tmpfs=/tmp:rw,nosuid,nodev,size=768m','--tmpfs=/pilot:rw,nosuid,nodev,size=128m',
  `--mount=type=bind,source=${copyRoot},target=/input,readonly`,`--mount=type=bind,source=${path.join(root,'code')},target=/source,readonly`,`--mount=type=bind,source=${path.join(root,'data')},target=/pilot/data`,
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
compile();fs.symlinkSync('/source/web','/pilot/web','dir');
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
export async function stageLocalPilot({root=defaultRoot,copyRoot}){
 if(!validPath(root)||!validPath(copyRoot))throw Error('Invalid pilot path');
 rejectLinkedPath(root);rejectLinkedPath(path.join(root,'data'));
 verifyControlledLinuxCopy(copyRoot);
 const native=path.join(copyRoot,'.local/full-instance/stage/app/src'),overlay=path.join(copyRoot,'.local/core-fix/appointment-identity-candidate/src');
 const candidate=await createFullHostCandidate(native,overlay,{conversationIntake:true,fullHostConversationExecution:true});
 const code=path.join(root,'code'),data=path.join(root,'data');
 if(fs.existsSync(code)||fs.existsSync(data)&&fs.readdirSync(data).length)throw Error('Local pilot requires fresh task-owned code/data');
 fs.mkdirSync(path.join(code,'src'),{recursive:true});fs.mkdirSync(data,{recursive:true});
 for(const [name,value] of candidate.files){const target=path.join(code,'src',name);fs.mkdirSync(path.dirname(target),{recursive:true});fs.writeFileSync(target,value);}
 const web=path.resolve(project,'../claw-agent-phase-one/.local/full-instance/stage/app/web/dist');
 if(!fs.existsSync(path.join(web,'index.html')))throw Error('Original Native built Web assets required');
 for(const [name,bytes] of treeFiles(web)){
  if(name.split('/').some(p=>p.startsWith('.env')||['data','config','.git'].includes(p)))throw Error('Unexpected Native Web asset');
  const target=path.join(code,'web/dist',name);fs.mkdirSync(path.dirname(target),{recursive:true});fs.writeFileSync(target,bytes);
 }
 fs.writeFileSync(path.join(code,'boot.mjs'),localPilotBootSource());
 const manifest={version:1,runId:randomUUID(),copyRoot:fs.realpathSync(copyRoot),codeHash:codeHash(code),nativeTree:candidate.audit.nativeTree,overlayTree:candidate.audit.overlayTree};
 manifest.name='qiwe-local-pilot-'+manifest.runId;
 fs.writeFileSync(path.join(root,'host.json'),JSON.stringify(manifest,null,2)+'\n',{flag:'wx'});
 return manifest;
}
export async function localPilotCommand(input,{root=defaultRoot,execute=spawnSync}={}){
 if(!['start','status','stop'].includes(input.command))throw Error('Invalid local pilot command');
 if(!validPath(root))throw Error('Invalid pilot path');
 rejectLinkedPath(root);rejectLinkedPath(path.join(root,'data'));
 const file=path.join(root,'host.json');
 if(!fs.existsSync(file)&&input.command!=='start')return {state:'not-initialized',restored:false};
 const invoke=(args,timeout=15000)=>{const r=execute('docker',args,{encoding:'utf8',timeout,windowsHide:true});if(r.error)throw r.error;return r;};
 const context=invoke(['context','inspect','desktop-linux','--format','{{.Endpoints.docker.Host}}']);
 if(context.status!==0||context.stdout.trim()!=='npipe:////./pipe/dockerDesktopLinuxEngine')throw Error('Pilot requires local Docker Desktop Linux pipe');
 const m=fs.existsSync(file)?JSON.parse(fs.readFileSync(file,'utf8')):await stageLocalPilot({root,copyRoot:input.copyRoot});
 if(m.version!==1||!validId(m.runId)||m.name!=='qiwe-local-pilot-'+m.runId||!validPath(m.copyRoot))throw Error('Local pilot ownership manifest invalid');
 if(input.command==='start'&&path.resolve(input.copyRoot)!==path.resolve(m.copyRoot))throw Error('Local pilot copy root mismatch');
 const inspect=()=>{
  const r=invoke(['--context','desktop-linux','inspect','--type=container','--format','{"name":{{json .Name}},"id":{{json .Id}},"running":{{json .State.Running}},"health":{{json .State.Health.Status}},"labels":{{json .Config.Labels}}}',m.name]);
  if(r.status!==0){if(/No such (?:object|container)/i.test(r.stderr??''))return null;throw Error('Local pilot container state unknown');}
  const v=JSON.parse(r.stdout);if(v.name!=='/'+m.name||v.labels?.[label]!==m.runId||typeof v.id!=='string'||!/^[a-f0-9]{64}$/.test(v.id))throw Error('Local pilot container ownership mismatch');return v;
 };
 let state=inspect();
 if(input.command==='status')return {state:state?.running?'running':state?'stopped':'not-created',health:state?.health??null,url:'http://127.0.0.1:'+port,data:path.join(root,'data'),restored:false};
 if(input.command==='stop'){
  if(state?.running){const stopped=invoke(['--context','desktop-linux','stop','--time=35',state.id],45000);if(stopped.status!==0)throw Error('Local pilot stop failed');}
  return {state:'stopped',data:path.join(root,'data'),restored:false};
 }
 verifyControlledLinuxCopy(m.copyRoot);
 if(codeHash(path.join(root,'code'))!==m.codeHash)throw Error('Local pilot code changed');
 if(!state){
  const network=m.name+'-web';
  const net=invoke(['--context','desktop-linux','network','inspect','--format','{"internal":{{json .Internal}},"labels":{{json .Labels}}}',network]);
  if(net.status===0){const observed=JSON.parse(net.stdout);if(observed.internal!==false||observed.labels?.[label]!==m.runId)throw Error('Local pilot network ownership mismatch');}
  else if([`Error: No such network: ${network}`,`Error response from daemon: No such network: ${network}`,`Error response from daemon: network ${network} not found`].includes((net.stderr??'').trim())){const created=invoke(['--context','desktop-linux','network','create','--driver','bridge','--label',label+'='+m.runId,network]);if(created.status!==0)throw Error('Local pilot network create failed');}
  else throw Error('Local pilot network state unknown');
  const started=invoke(localPilotContainerArguments({root,copyRoot:m.copyRoot,runId:m.runId}),30000);if(started.status!==0)throw Error('Local pilot start failed');
 }else if(!state.running){const started=invoke(['--context','desktop-linux','start',state.id],30000);if(started.status!==0)throw Error('Local pilot start failed');}
 state=inspect();
 return {state:state?.running?'running':'not-running',health:state?.health??'starting',url:'http://127.0.0.1:'+port,data:path.join(root,'data'),restored:false,scope:'Native setup/login only; original business gate remains paused'};
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 try{console.log(JSON.stringify(await localPilotCommand(parseLocalPilotArguments(process.argv.slice(2))),null,2));}catch(e){console.error(e instanceof Error?e.message:'Local pilot failed');process.exitCode=1;}
}
