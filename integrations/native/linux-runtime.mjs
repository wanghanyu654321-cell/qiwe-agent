import fs from 'node:fs';
import path from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';

export const linuxImage='node@sha256:48e4b67d85f87bd551df43704e24d252f56cc5f8e9718841aace50f19948f0f9';
const sha256=bytes=>createHash('sha256').update(bytes).digest('hex');
const binarySha256='df9fbd0d061f360d81fb51e265c53c9605020bd68219e34f33c07c85de15719a';
const libTreeSha256='a4e98fd5dcc223811c57fe5189d0640dc47457c91bcbeea95e4cceb4fb1f5002';
export function runLinuxContainer(copyRoot,entryArguments,{execute=spawnSync,nonce=randomUUID()}={}){
  if(!/^[a-f0-9-]{36}$/.test(nonce))throw Error('Invalid Linux run identity');
  const name='qiwe-native-linux-'+nonce,label='qiwe.native.linux.validation';
  const context=execute('docker',['context','inspect','desktop-linux','--format','{{.Endpoints.docker.Host}}'],{encoding:'utf8',timeout:10000});
  if(context.status!==0||context.stdout.trim()!=='npipe:////./pipe/dockerDesktopLinuxEngine')throw Error('Linux validation requires the local Docker Desktop Linux pipe');
  const command=linuxContainerArguments(copyRoot,entryArguments);
  command.splice(command.indexOf('--entrypoint=node'),0,'--name='+name,'--label='+label+'='+nonce);
  try{
    const result=execute('docker',command,{stdio:'inherit',timeout:240000});
    if(result.error)throw result.error;return result.status??1;
  }finally{
    const inspect=()=>{
      const result=execute('docker',['--context','desktop-linux','inspect','--type=container','--format','{"name":{{json .Name}},"labels":{{json .Config.Labels}},"running":{{json .State.Running}}}',name],{encoding:'utf8',timeout:10000});
      if(result.status!==0){if(/No such (?:container|object)/i.test(result.stderr??''))return null;throw Error('Owned Linux container cleanup state is unknown: '+name);}
      const value=JSON.parse(result.stdout);return value.name==='/'+name&&value.labels?.[label]===nonce?value:null;
    };
    let own=inspect();
    if(own){
        if(own.running){execute('docker',['--context','desktop-linux','stop','--time=5',name],{encoding:'utf8',timeout:10000});own=inspect();}
        if(own){
        const removed=execute('docker',['--context','desktop-linux','rm','--force',name],{encoding:'utf8',timeout:10000});
        if(removed.status!==0&&inspect())throw Error('Failed to remove the owned Linux validation container: '+name);
        }
    }
  }
}
const stageMarker='.qiwe-linux-stage.json';
const stageTrees=['qiwe-agent/src/','qiwe-agent/integrations/native/','qiwe-agent/node_modules/','.local/full-instance/stage/app/src/','.local/full-instance/stage/app/node_modules/','.local/core-fix/appointment-identity-candidate/src/','.local/frontagent-existing-input/'];
const stageFiles=['qiwe-agent/package.json','qiwe-agent/package-lock.json','qiwe-agent/tsconfig.json','qiwe-agent/tsconfig.build.json','qiwe-agent/tests/fixtures/offline-bot-sdk.ts','.local/full-instance/stage/app/package.json','.local/full-instance/stage/app/package-lock.json','.local/full-instance/stage/app/tsconfig.json'];
const runnerStage='.local/full-instance/stage/app/container/agent-runner/';
stageTrees.push(...['src/','prompts/','node_modules/'].map(name=>runnerStage+name));
stageFiles.push(runnerStage+'package.json',runnerStage+'package-lock.json',runnerStage+'tsconfig.json');
stageFiles.push(...['Dockerfile','.dockerignore','entrypoint.sh','session-generated-paths.mjs','session-permissions-mount.mjs','session-permissions-watcher.mjs','session-permissions.sh','session-prompts-copy.mjs'].map(name=>'.local/full-instance/stage/app/container/'+name));
stageFiles.push(...['beauty-local-content','vendor-content-strategy','vendor-copywriting'].map(id=>`.local/d4-skills/${id}/SKILL.md`));
const existingUnit='.local/frontagent-existing-input';
export const existingInputManifest='.local/frontagent-existing-input.manifest.json';
stageFiles.push(existingInputManifest);
const codeRestage=[['src','qiwe-agent/src'],['integrations/native','qiwe-agent/integrations/native'],['package.json','qiwe-agent/package.json'],['package-lock.json','qiwe-agent/package-lock.json'],['tsconfig.json','qiwe-agent/tsconfig.json'],['tsconfig.build.json','qiwe-agent/tsconfig.build.json'],['tests/fixtures/offline-bot-sdk.ts','qiwe-agent/tests/fixtures/offline-bot-sdk.ts']];
function rejectLinked(target){const stat=fs.lstatSync(target);if(stat.isSymbolicLink())throw Error('Stage symlinks are forbidden');if(stat.isFIFO()||stat.isSocket())throw Error('Stage special files are forbidden');return stat;}
const existingRoot=['code','descriptor.json','state'];
function assertExistingUnitRoot(dir){
  const names=fs.readdirSync(dir).sort();
  if(names.join('\0')!==existingRoot.join('\0'))throw Error('Unapproved stage path: '+existingUnit);
  const descriptor=path.join(dir,'descriptor.json'),stat=rejectLinked(descriptor);
  if(!stat.isFile()||stat.nlink!==1)throw Error('Unapproved stage path: '+existingUnit+'/descriptor.json');
  return descriptor;
}
function walkExistingUnit(dir,visit){
  const walk=relative=>{const absolute=path.join(dir,relative),stat=rejectLinked(absolute);
    if(stat.isDirectory()){for(const name of fs.readdirSync(absolute).sort())walk(relative?relative+'/'+name:name);return;}
    if(!stat.isFile()||stat.nlink!==1)throw Error('Unapproved stage path: '+existingUnit+'/'+relative);
    visit(relative,absolute,stat);
  };
  for(const name of ['state','code'])walk(name);
}
export function writeExistingInputManifest(copyRoot){
  const dir=path.join(copyRoot,existingUnit);
  if(!fs.existsSync(dir))return null;
  const descriptor=assertExistingUnitRoot(dir),files={};
  walkExistingUnit(dir,(relative,absolute,stat)=>{files[relative]={sha256:sha256(fs.readFileSync(absolute)),size:stat.size};});
  const body={format:'qiwe-existing-input-v1',files,descriptorSha256:sha256(fs.readFileSync(descriptor))};
  const manifest=path.join(copyRoot,existingInputManifest);
  fs.writeFileSync(manifest,JSON.stringify(body,null,2)+'\n');
  return manifest;
}
function verifyExistingInputUnit(copyRoot){
  const dir=path.join(copyRoot,existingUnit),manifestPath=path.join(copyRoot,existingInputManifest);
  if(!fs.existsSync(dir))return;
  if(!fs.existsSync(manifestPath))throw Error('Existing input manifest required');
  const manifest=JSON.parse(fs.readFileSync(manifestPath,'utf8'));
  if(manifest.format!=='qiwe-existing-input-v1'||!manifest.files||typeof manifest.files!=='object'||typeof manifest.descriptorSha256!=='string')throw Error('Existing input manifest required');
  const descriptor=assertExistingUnitRoot(dir);
  if(sha256(fs.readFileSync(descriptor))!==manifest.descriptorSha256)throw Error('Controlled copy inventory changed');
  const found=[];
  walkExistingUnit(dir,(relative,absolute,stat)=>{
    const recorded=manifest.files[relative];
    if(!recorded||recorded.size!==stat.size||sha256(fs.readFileSync(absolute))!==recorded.sha256)throw Error('Controlled copy inventory changed');
    found.push(relative);
  });
  if(found.sort().join('\0')!==Object.keys(manifest.files).sort().join('\0'))throw Error('Controlled copy inventory changed');
}
function stageInventory(copyRoot){
  const files={};
  const walk=(directory,prefix='')=>{for(const entry of fs.readdirSync(directory,{withFileTypes:true})){
    const name=prefix+entry.name;
    if(entry.isSymbolicLink())throw Error('Stage symlinks are forbidden');
    if(name===stageMarker){if(!entry.isFile())throw Error('Stage marker must be a regular file');continue;}
    if(name===existingUnit&&entry.isDirectory())continue;
    if(name.split('/').some(part=>/^\.env(?:\.|$)/.test(part)||['.git','.bin','.vite','.vite-temp'].includes(part)))throw Error('Unapproved stage path: '+name);
    const allowed=entry.isDirectory()?stageTrees.some(tree=>tree.startsWith(name+'/')||(name+'/').startsWith(tree))||stageFiles.some(file=>file.startsWith(name+'/')):stageFiles.includes(name)||stageTrees.some(tree=>name.startsWith(tree));
    if(!allowed||!entry.isFile()&&!entry.isDirectory())throw Error('Unapproved stage path: '+name);
    const target=path.join(directory,entry.name);if(entry.isDirectory())walk(target,name+'/');else files[name]=sha256(fs.readFileSync(target));
  }};walk(copyRoot);return Object.fromEntries(Object.entries(files).sort(([a],[b])=>a.localeCompare(b,'en')));
}
export function restageControlledCode(repoRoot,copyRoot){
  let copied=0;
  for(const [from,to] of codeRestage){
    const source=path.join(repoRoot,from);
    if(!fs.existsSync(source))continue;
    const dest=path.join(copyRoot,to);
    fs.rmSync(dest,{recursive:true,force:true});
    fs.mkdirSync(path.dirname(dest),{recursive:true});
    fs.cpSync(source,dest,{recursive:true,filter:src=>!src.split(path.sep).includes('node_modules')});
    copied++;
  }
  return copied;
}
export function sealControlledLinuxCopy(copyRoot,commit){
  writeExistingInputManifest(copyRoot);
  const files=stageInventory(copyRoot);
  const marker={format:'qiwe-linux-controlled-copy-v1',files,...(commit?{commit}:{})};
  fs.writeFileSync(path.join(copyRoot,stageMarker),JSON.stringify(marker,null,2)+'\n');
  return {files:Object.keys(files).length,commit:commit??null};
}
export function verifyControlledLinuxCopy(copyRoot,commit){
  verifyExistingInputUnit(copyRoot);
  const files=stageInventory(copyRoot);
  const marker=JSON.parse(fs.readFileSync(path.join(copyRoot,stageMarker),'utf8'));
  if(marker.format!=='qiwe-linux-controlled-copy-v1'||JSON.stringify(marker.files)!==JSON.stringify(files))throw Error('Controlled copy inventory changed');
  if(commit&&marker.commit!==commit){const error=Error('PILOT_LAUNCH_STAGE_SEAL');error.reason='commit';throw error;}
  return {files:Object.keys(files).length,commit:marker.commit??null};
}

export function linuxContainerArguments(copyRoot,entryArguments){
  if(typeof copyRoot!=='string'||!path.isAbsolute(copyRoot)||/[\r\n,]/.test(copyRoot)||/^[A-Za-z]:[\\/]*$/.test(copyRoot)||path.parse(path.resolve(copyRoot)).root===path.resolve(copyRoot))throw Error('An absolute, dedicated copy root is required');
  if(!Array.isArray(entryArguments)||!/^\/input\/.+\.mjs$/.test(entryArguments[0]??''))throw Error('A copied /input entry point is required');
  return ['--context','desktop-linux','run','--rm','--pull=never','--network=none','--read-only','--cap-drop=ALL','--security-opt=no-new-privileges','--pids-limit=256','--memory=4g','--cpus=2','--tmpfs=/tmp:rw,nosuid,nodev,size=768m',`--mount=type=bind,source=${copyRoot},target=/input,readonly`,'--workdir=/tmp','--env=HOME=/tmp','--env=TMPDIR=/tmp','--env=QIWE_EVIDENCE_ROOT=/tmp/qiwe-full-host-evidence','--entrypoint=node',linuxImage,...entryArguments];
}

// Admit only the already supplied Linux original; never rebuild, replace it,
// or infer readiness from a manifest written by a caller.
export function verifyOriginalLinuxSqlite(source){
  if(process.platform!=='linux'||process.arch!=='x64'||process.versions.modules!=='127')throw Error('Original driver requires Linux x64 Node ABI 127');
  if(!source||!path.isAbsolute(source))throw Error('An absolute Native source is required');
  source=fs.realpathSync(source);
  const app=path.dirname(source),packagePath=path.join(app,'node_modules/better-sqlite3');
  const lock=JSON.parse(fs.readFileSync(path.join(app,'package-lock.json'),'utf8')).packages?.['node_modules/better-sqlite3'];
  if(lock?.version!=='12.11.1'||lock?.integrity!=='sha512-dq9AtApgg5PGFtBzPFSBl3HZQjHok5gaQCM6zh2Yk0aSmDCs1CbnVI8/HgASQkNKsWFpseIO9beg5xxpYhbIfA==')throw Error('Original Linux sqlite lock changed');
  if(sha256(fs.readFileSync(path.join(packagePath,'package.json')))!=='4665126292eff5dffe6c0ffabf98c4de18e479aa0b53edd775028eb567b3ecc1')throw Error('Original Linux sqlite metadata changed');
  const hash=createHash('sha256'),files=[];
  const walk=(directory,prefix='')=>{for(const entry of fs.readdirSync(directory,{withFileTypes:true})){if(entry.isSymbolicLink()||!entry.isDirectory()&&!entry.isFile())throw Error('Unexpected Linux sqlite lib member');if(entry.isDirectory())walk(path.join(directory,entry.name),prefix+entry.name+'/');else files.push(prefix+entry.name);}};
  walk(path.join(packagePath,'lib'));
  for(const relative of files.sort()){hash.update(relative+'\0');hash.update(fs.readFileSync(path.join(packagePath,'lib',relative)));}
  if(hash.digest('hex')!==libTreeSha256)throw Error('Original Linux sqlite JS changed');
  const binary=fs.readFileSync(path.join(packagePath,'build/Release/better_sqlite3.node'));
  if(binary.length<64||binary.toString('hex',0,4)!=='7f454c46'||binary[4]!==2||binary[5]!==1||binary.readUInt16LE(18)!==62||sha256(binary)!==binarySha256)throw Error('Original Linux x64 sqlite binary changed');
  const require=createRequire(path.join(packagePath,'package.json'));
  for(const [name,version,main,digest] of [['bindings','1.5.0','bindings.js','8e32a0d37f20bd6f7d5bdbf99d041aa27be47cbbe5172ac13ebf7380a10b3bf6'],['file-uri-to-path','1.0.0','index.js','e62293e871bdd5a7449ff3c7956c9536ec1d2ea7369461de77322b5256bb93e7']]){
    const expected=path.join(app,'node_modules',name,main);
    if(JSON.parse(fs.readFileSync(path.join(app,'node_modules',name,'package.json'),'utf8')).version!==version||fs.realpathSync(require.resolve(name))!==fs.realpathSync(expected)||sha256(fs.readFileSync(expected))!==digest)throw Error('Original Linux sqlite loader changed: '+name);
  }
  const Database=require(packagePath),db=new Database(':memory:');
  try{if(db.prepare('SELECT 1 AS loaded').get().loaded!==1)throw Error('Linux original sqlite load failed');}finally{db.close();}
  return {packagePath,version:'12.11.1',node:process.version,platform:process.platform,arch:process.arch,abi:process.versions.modules,binarySha256,libTreeSha256};
}

if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  const args=process.argv.slice(2);
  if(args.length!==1)throw Error('Usage: node integrations/native/linux-runtime.mjs ABSOLUTE_CONTROLLED_COPY_ROOT');
  const root=fs.realpathSync(args[0]);
  verifyControlledLinuxCopy(root);
  for(const relative of ['qiwe-agent/integrations/native/verify-full-host.mjs','qiwe-agent/package-lock.json','.local/full-instance/stage/app/src/sqlite-compat.ts','.local/core-fix/appointment-identity-candidate/src/appointment-boot-gate.ts'])if(!fs.statSync(path.join(root,relative)).isFile())throw Error('Controlled copy is incomplete: '+relative);
  process.exitCode=runLinuxContainer(root,['/input/qiwe-agent/integrations/native/verify-full-host.mjs','/input/.local/full-instance/stage/app/src','--host-overlay','/input/.local/core-fix/appointment-identity-candidate/src']);
}
