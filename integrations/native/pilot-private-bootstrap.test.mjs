import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {assertIsolatedSyntheticClosed,installVerifiedPilotPrivateConfig,readHostPilotPrivateFile,runContainerPrivateInstall} from './pilot-private-bootstrap.mjs';

const secret='host-file-secret-value';
const modelKey='host-file-model-key';
const body=()=>JSON.stringify({bot:{botId:'bot-id-example',corpId:'corp-id-example',secret},model:{apiKey:modelKey,baseUrl:'https://api.deepseek.com/anthropic',model:'deepseek-flash'}});
function scratch(){const root=fs.mkdtempSync(path.join(os.tmpdir(),'qiwe-private-bootstrap-'));return {root,cleanup:()=>fs.rmSync(root,{recursive:true,force:true})};}
function writeHost(root,text=body(),mode=0o600){const file=path.join(root,'host-private.json');fs.writeFileSync(file,text,{mode});return file;}

test('host file read returns an independent frozen copy and ignores a later rewrite',()=>{
 const f=scratch();try{
  const file=writeHost(f.root);
  const first=readHostPilotPrivateFile(file);
  assert.equal(Object.isFrozen(first)&&Object.isFrozen(first.bot)&&Object.isFrozen(first.model),true);
  assert.throws(()=>{first.bot.botId='mutated';},TypeError);
  fs.writeFileSync(file,body().replace('bot-id-example','bot-id-other'),{mode:0o600});
  assert.equal(first.bot.botId,'bot-id-example');
  assert.equal(readHostPilotPrivateFile(file).bot.botId,'bot-id-other');
  assert.equal(JSON.stringify(first).includes(secret),true);
 }finally{f.cleanup();}
});

test('install writes uid 1000 mode 0600 from the host file and drops a late host rewrite',()=>{
 const f=scratch();try{
  const file=writeHost(f.root),destination=path.join(f.root,'container','qiwe-live-pilot.private.json');
  fs.mkdirSync(path.dirname(destination));
  let published=false;
  assert.throws(()=>installVerifiedPilotPrivateConfig({hostFile:file,destination,beforePublish(){fs.writeFileSync(file,body().replace(secret,'changed-secret-value'),{mode:0o600});published=true;}}),error=>error.message==='PILOT_PRIVATE_INPUT_CHANGED'&&!error.message.includes(secret));
  assert.equal(published,true);assert.equal(fs.existsSync(destination),false);
  fs.writeFileSync(file,body(),{mode:0o600});
  const installed=installVerifiedPilotPrivateConfig({hostFile:file,destination});
  const stat=fs.lstatSync(destination);
  assert.deepEqual(installed,{uid:1000,gid:1000,mode:0o600,nlink:1,bytes:Buffer.byteLength(body())});
  assert.equal(stat.uid,1000);assert.equal(stat.gid,1000);assert.equal(stat.nlink,1);assert.equal(stat.mode&0o777,0o600);
  assert.equal(fs.readFileSync(destination,'utf8'),body());
  assert.equal(JSON.stringify(installed).includes(secret)||JSON.stringify(installed).includes(modelKey),false);
 }finally{f.cleanup();}
});

test('symlink, extra link, loose mode and bad shape are refused without echoing secrets',()=>{
 const f=scratch();try{
  const file=writeHost(f.root),destination=path.join(f.root,'dest.json'),link=path.join(f.root,'link.json');
  fs.symlinkSync(file,link);
  assert.throws(()=>readHostPilotPrivateFile(link),/PILOT_PRIVATE_FILE_UNSAFE/);
  fs.linkSync(file,path.join(f.root,'hard.json'));
  assert.throws(()=>readHostPilotPrivateFile(file),/PILOT_PRIVATE_FILE_UNSAFE/);
  fs.unlinkSync(path.join(f.root,'hard.json'));
  fs.chmodSync(file,0o640);
  assert.throws(()=>installVerifiedPilotPrivateConfig({hostFile:file,destination}),error=>error.message==='PILOT_PRIVATE_FILE_UNSAFE'&&!String(error).includes(secret));
  fs.chmodSync(file,0o600);fs.writeFileSync(file,JSON.stringify({bot:{secret}}),{mode:0o600});
  assert.throws(()=>installVerifiedPilotPrivateConfig({hostFile:file,destination}),error=>error.message==='CONTROLLED_REAL_PRIVATE_INPUT_INVALID'&&!error.message.includes(secret));
  assert.equal(fs.existsSync(destination),false);
 }finally{f.cleanup();}
});

const digestOf=text=>createHash('sha256').update(text).digest('hex');
function containerExec(file,text,onCp){
 const calls=[],digest=digestOf(text);
 const execFileSync=(command,args)=>{
  calls.push([command,...args]);
  if(args.includes('cp')){onCp?.(args);return '';}
  if(args.includes('sha256sum'))return `${digest}  /tmp/qiwe-live-pilot.private.json\n`;
  if(args.includes('stat'))return `1000 1000 600 1 ${Buffer.byteLength(text)}\n`;
  return '';
 };
 return {calls,execFileSync};
}
test('container install copies the verified snapshot and checks the in-container hash',()=>{
 const f=scratch();try{
  const file=writeHost(f.root),text=body();
  const {calls,execFileSync}=containerExec(file,text,args=>{
   const source=args[args.indexOf('--')+1];
   assert.notEqual(path.resolve(source),path.resolve(file));
   assert.equal(fs.readFileSync(source).equals(Buffer.from(text)),true);
  });
  const installed=runContainerPrivateInstall({docker:'docker',container:'qiwe-pilot-host',hostFile:file,destination:'/tmp/qiwe-live-pilot.private.json',execFileSync});
  assert.deepEqual(installed,{uid:1000,gid:1000,mode:0o600,nlink:1,bytes:Buffer.byteLength(text)});
  const flat=JSON.stringify(calls);
  assert.equal(flat.includes(secret)||flat.includes(modelKey)||flat.includes(file),false);
  const copied=calls.find(argv=>argv.includes('cp'));
  assert.match(copied.at(-1),/^qiwe-pilot-host:\/tmp\/qiwe-private-[a-f0-9]{16}$/);
  const temp=copied.at(-1).slice('qiwe-pilot-host:'.length);
  assert.equal(calls.some(argv=>argv.includes('sha256sum')&&argv.includes(temp)),true);
  assert.equal(calls.some(argv=>argv.includes('mv')&&argv.includes(temp)&&argv.includes('/tmp/qiwe-live-pilot.private.json')),true);
  assert.equal(calls.some(argv=>argv.includes('rm')||argv.includes('qiwe-pilot-host:/tmp/qiwe-live-pilot.private.json')),false);
  assert.equal(calls.some(argv=>['sh','bash','node'].includes(argv[0])||argv.includes(text)),false);
 }finally{f.cleanup();}
});
test('container install keeps the snapshot when the host file is swapped for the copy and restored',()=>{
 const f=scratch();try{
  const file=writeHost(f.root),text=body(),swapped=text.replace(secret,'host-file-secret-other');
  assert.equal(Buffer.byteLength(swapped),Buffer.byteLength(text));
  const {execFileSync}=containerExec(file,text,args=>{
   fs.writeFileSync(file,swapped,{mode:0o600});
   const source=args[args.indexOf('--')+1];
   assert.equal(fs.readFileSync(source).equals(Buffer.from(text)),true);
   fs.writeFileSync(file,text,{mode:0o600});
  });
  const installed=runContainerPrivateInstall({docker:'docker',container:'qiwe-pilot-host',hostFile:file,destination:'/tmp/qiwe-live-pilot.private.json',execFileSync});
  assert.equal(installed.bytes,Buffer.byteLength(text));
 }finally{f.cleanup();}
});
test('container install removes the destination after chown, stat, or post-copy snapshot failure',()=>{
 const f=scratch();try{
  const file=writeHost(f.root),text=body();
  for(const kind of ['chown','stat','snapshot']){
   let copied=0,removed=0;
   let removedPath;
   assert.throws(()=>runContainerPrivateInstall({docker:'docker',container:'qiwe-pilot-host',hostFile:file,destination:'/tmp/qiwe-live-pilot.private.json',execFileSync(command,args){
    if(args.includes('rm')){removed++;removedPath=args.at(-1);return '';}
    if(args.includes('cp')){copied++;return '';}
    if(kind==='chown'&&args.includes('chown'))throw Error('boom '+secret);
    if(kind==='snapshot'&&args.includes('sha256sum'))fs.chmodSync(file,0o644);
    if(args.includes('sha256sum'))return `${digestOf(text)}  /tmp/qiwe-private-temp\n`;
    if(args.includes('stat'))return kind==='stat'?`1000 1000 644 1 ${Buffer.byteLength(text)}\n`:`1000 1000 600 1 ${Buffer.byteLength(text)}\n`;
    return '';
   }}),error=>!String(error.message).includes(secret)&&(error.message==='PILOT_PRIVATE_CONTAINER_UNVERIFIED'||error.message==='PILOT_PRIVATE_FILE_UNSAFE'||error.message==='PILOT_PRIVATE_INPUT_CHANGED'));
   assert.equal(copied,1,kind);assert.equal(removed,1,kind);
   assert.match(removedPath,/^\/tmp\/qiwe-private-[a-f0-9]{16}$/);
   assert.notEqual(removedPath,'/tmp/qiwe-live-pilot.private.json');
   fs.chmodSync(file,0o600);
  }
 }finally{f.cleanup();}
});
test('a failed docker cp does not remove a container path',()=>{
 const f=scratch();try{
  const file=writeHost(f.root);
  let removed=0;
  assert.throws(()=>runContainerPrivateInstall({docker:'docker',container:'qiwe-pilot-host',hostFile:file,destination:'/tmp/qiwe-live-pilot.private.json',execFileSync(command,args){
   if(args.includes('rm'))removed++;
   if(args.includes('cp'))throw Error('cp failed '+secret);
   return '';
  }}),error=>error.message==='PILOT_PRIVATE_CONTAINER_UNVERIFIED'&&!error.message.includes(secret));
  assert.equal(removed,0);
 }finally{f.cleanup();}
});
test('install does not replace or delete a final name that appears after the absence check',()=>{
 const f=scratch();try{
  const destination=path.join(f.root,'container','secret.json'),occupant='OCCUPANT_NOT_OURS\n';
  fs.mkdirSync(path.dirname(destination));
  assert.throws(()=>installVerifiedPilotPrivateConfig({hostFile:writeHost(f.root),destination,beforePublish(){fs.writeFileSync(destination,occupant,{mode:0o600});}}),error=>error.message==='PILOT_PRIVATE_DESTINATION_INVALID'&&!error.message.includes(secret)&&!error.message.includes('OCCUPANT'));
  assert.equal(fs.readFileSync(destination,'utf8'),occupant);
  assert.deepEqual(fs.readdirSync(path.dirname(destination)),['secret.json']);
 }finally{f.cleanup();}
});
test('install rejects a symlink in an ancestor and does not write the target',()=>{
 const f=scratch();try{
  const target=path.join(f.root,'evil-target','sub');
  fs.mkdirSync(target,{recursive:true});
  fs.symlinkSync(path.join(f.root,'evil-target'),path.join(f.root,'pilot-link'));
  const destination=path.join(f.root,'pilot-link','sub','secret.json');
  assert.throws(()=>installVerifiedPilotPrivateConfig({hostFile:writeHost(f.root),destination}),/PILOT_PRIVATE_DESTINATION_INVALID/);
  assert.equal(fs.existsSync(path.join(target,'secret.json')),false);
 }finally{f.cleanup();}
});
test('model provider env names refuse isolated-synthetic without echoing values',()=>{
 const absent=path.join(os.tmpdir(),'qiwe-missing-private.json'),token='deepseek-key-not-for-logs';
 const refused=['DEEPSEEK_API_KEY','DEEPSEEK_MODEL','ANTHROPIC_BASE_URL','OPENAI_BASE_URL','DEEPSEEK_BASE_URL','OPENAI_API_KEY','VENDOR_API_KEY','VENDOR_AUTH_TOKEN','VENDOR_SECRET','QIWE_PRIVATE_API_KEY'];
 for(const name of refused){
  assert.throws(()=>assertIsolatedSyntheticClosed({PATH:'/usr/bin',[name]:token},absent,{root:os.tmpdir()}),error=>error.message==='ISOLATED_SYNTHETIC_REAL_CREDENTIAL'&&!error.message.includes(token)&&!error.message.includes(name));
 }
 assert.doesNotThrow(()=>assertIsolatedSyntheticClosed({PATH:'/usr/bin',DEEPSEEK_API_KEY:'',ANTHROPIC_MODEL:'deepseek-flash',QIWE_PILOT_ENTRY_MODE:'isolated-synthetic',QIWE_SYNTHETIC_DATA_DIR:'/tmp/qiwe-synthetic'},absent,{root:os.tmpdir()}));
});
test('credential names are matched without case and cover provider families',()=>{
 const absent=path.join(os.tmpdir(),'qiwe-missing-private.json'),token='mixed-case-key-not-for-logs';
 const refused=['deepseek_api_key','Anthropic_Base_Url','ANTHROPIC_CUSTOM_HEADERS','OPENAI_API_BASE','AWS_ACCESS_KEY_ID','AWS_SECRET_ACCESS_KEY','HF_TOKEN','gemini_api_key','WeCom_Bot_Secret'];
 for(const name of refused){
  assert.throws(()=>assertIsolatedSyntheticClosed({PATH:'/usr/bin',[name]:`  ${token}  `},absent,{root:os.tmpdir()}),error=>error.message==='ISOLATED_SYNTHETIC_REAL_CREDENTIAL'&&!error.message.includes(token)&&!error.message.includes(name));
 }
 assert.doesNotThrow(()=>assertIsolatedSyntheticClosed({PATH:'/usr/bin',anthropic_model:'deepseek-flash',DEEPSEEK_API_KEY:'   ',QIWE_SYNTHETIC_FOLDER:'marketing'},absent,{root:os.tmpdir()}));
});
test('documented live model and channel env files refuse isolated-synthetic without being read aloud',()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'qiwe-live-env-'));
 try{
  const absent=path.join(root,'missing-private.json'),token='not-printed-live-token';
  assert.doesNotThrow(()=>assertIsolatedSyntheticClosed({PATH:'/usr/bin'},absent,{root}));
  for(const relative of ['.local/live-model/.env','.local/live-channel/.env']){
   const file=path.join(root,relative);
   fs.mkdirSync(path.dirname(file),{recursive:true});
   fs.writeFileSync(file,`TOKEN=${token}\n`,{mode:0o600});
   assert.throws(()=>assertIsolatedSyntheticClosed({PATH:'/usr/bin'},absent,{root}),error=>error.message==='ISOLATED_SYNTHETIC_REAL_CREDENTIAL'&&!error.message.includes(token));
   fs.rmSync(file);
  }
 }finally{fs.rmSync(root,{recursive:true,force:true});}
});
