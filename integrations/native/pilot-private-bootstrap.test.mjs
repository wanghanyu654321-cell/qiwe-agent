import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {assertIsolatedSyntheticClosed,installVerifiedPilotPrivateConfig,parseWindowsAclProbe,readHostPilotPrivateFile as readHostRaw,runContainerPrivateInstall as installRaw,stageWindowsPrivateFile,windowsAclProbeArgs,windowsAclProbeScript,windowsAllowAces} from './pilot-private-bootstrap.mjs';
const linuxOnly={skip:process.platform!=='linux'&&'Linux /proc uid and mode 0600'};
function winFile(file){
 if(process.platform!=='win32'||typeof file!=='string')return {};
 const sid='S-1-5-21-1-2-3-1001';
 return {platform:'win32',homedir:path.dirname(file),realpath:()=>file,currentSid:sid,reparsePoint:false,aces:[{sid,type:'Allow',inherited:false}]};
}
function readHostPilotPrivateFile(file,options){return readHostRaw(file,{...winFile(file),...options});}
function runContainerPrivateInstall(options){return installRaw({...winFile(options?.hostFile),...options});}

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

test('install writes uid 1000 mode 0600 from the host file and drops a late host rewrite',linuxOnly,()=>{
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

test('windows mode 0666 is accepted only for explicit allow SIDs, not a name inside the path',()=>{
 const userSid='S-1-5-21-100-200-300-1001',allow=sid=>({sid,type:'Allow',inherited:false});
 const f=scratch();try{
  const home=path.join(f.root,'张伟');fs.mkdirSync(home);
  const file=writeHost(home);fs.chmodSync(file,0o666);
  const base={platform:'win32',homedir:home,realpath:()=>file,currentSid:userSid,reparsePoint:false};
  assert.equal(windowsAllowAces([allow(userSid),allow('S-1-5-18'),allow('S-1-5-32-544')],userSid),true);
  assert.equal(windowsAllowAces([allow('S-1-5-18'),allow('S-1-5-32-544')],userSid),false);
  assert.equal(windowsAllowAces([allow(userSid),allow('S-1-1-0')],userSid),false);
  assert.equal(windowsAllowAces([allow(userSid),allow('S-1-5-11')],userSid),false);
  assert.equal(windowsAllowAces([allow(userSid),allow('S-1-5-32-545')],userSid),false);
  assert.equal(windowsAllowAces([allow(userSid),allow('S-1-5-32-546')],userSid),false);
  assert.equal(windowsAllowAces([{sid:userSid,type:'Allow',inherited:true}],userSid),false);
  assert.equal(windowsAllowAces([{sid:userSid,type:'Deny',inherited:false}],userSid),false);
  assert.throws(()=>readHostPilotPrivateFile(file,{...base,user:'张伟',aces:[allow('S-1-1-0')]}),error=>error.message==='PILOT_PRIVATE_FILE_UNSAFE'&&error.reason==='acl'&&!error.message.includes('张伟')&&error.reason!=='张伟');
  assert.throws(()=>readHostPilotPrivateFile(file,{...base,user:'Müller',aces:[allow(userSid)],reparsePoint:true}),error=>error.message==='PILOT_PRIVATE_FILE_UNSAFE'&&error.reason==='reparse');
  assert.throws(()=>readHostPilotPrivateFile(file,{platform:'linux',homedir:home,currentSid:userSid,aces:[allow(userSid)],realpath:()=>file}),error=>error.message==='PILOT_PRIVATE_FILE_UNSAFE'&&error.reason==='mode');
  const accepted=readHostPilotPrivateFile(file,{...base,user:'Müller',aces:[allow(userSid),allow('S-1-5-18'),allow('S-1-5-32-544')]});
  assert.equal(accepted.bot.botId,'bot-id-example');
  assert.equal(JSON.stringify(accepted).includes('Müller')||JSON.stringify(accepted).includes('张伟'),false);
 }finally{f.cleanup();}
});
test('symlink, extra link, loose mode and bad shape are refused without echoing secrets',linuxOnly,()=>{
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
 const calls=[];let received=Buffer.alloc(0);
 const execFileSync=(command,args,options)=>{
  calls.push([command,...args]);
  if(args.some(item=>String(item).includes('cat >'))){
   received=options?.stdio?.[0]==='pipe'?Buffer.from(options?.input??''):Buffer.alloc(0);
   onCp?.(command,args,options);
   return '';
  }
  if(args.includes('sha256sum'))return `${createHash('sha256').update(received).digest('hex')}  ${args.at(-1)}\n`;
  if(args.includes('stat'))return `1000 1000 600 1 ${received.length}\n`;
  return '';
 };
 return {calls,execFileSync,stdinBytes:()=>received.length};
}
test('container install copies the verified snapshot and checks the in-container hash',()=>{
 const f=scratch();try{
  const file=writeHost(f.root),text=body();
  const {calls,execFileSync}=containerExec(file,text,(command,args,opts)=>{
   const script=args.find(item=>String(item).includes('cat >'));
   assert.equal(Boolean(script),true);
   assert.equal(Buffer.from(opts?.input??'').equals(Buffer.from(text)),true);
   assert.equal(JSON.stringify(args).includes(file),false);
  });
  const installed=runContainerPrivateInstall({docker:'docker',container:'qiwe-pilot-host',hostFile:file,destination:'/tmp/qiwe-live-pilot.private.json',execFileSync});
  assert.deepEqual(installed,{uid:1000,gid:1000,mode:0o600,nlink:1,bytes:Buffer.byteLength(text)});
  const flat=JSON.stringify(calls);
  assert.equal(flat.includes(secret)||flat.includes(modelKey)||flat.includes(file),false);
  assert.equal(calls.some(argv=>argv.includes('chown')),false);
  const write=calls.find(argv=>argv.some(item=>String(item).includes('cat >')));
  const temp=String(write.find(item=>String(item).includes('cat >'))).match(/\/tmp\/qiwe-private-[a-f0-9]{16}/)[0],finalPath='/tmp/qiwe-live-pilot.private.json';
  const at=(pred)=>calls.findIndex(pred);
  const statTemp=at(argv=>argv.includes('stat')&&argv.includes(temp));
  const linked=at(argv=>argv.includes('ln'));
  const removedTemp=at(argv=>argv.includes('rm')&&argv.includes(temp));
  const statFinal=at(argv=>argv.includes('stat')&&argv.includes(finalPath)&&argv.includes('1000:1000'));
  assert.ok(statTemp!==-1&&statTemp<linked&&linked<removedTemp&&removedTemp<statFinal);
  assert.equal(calls[linked].includes('-T'),true);
  assert.equal(calls[linked].includes('-f'),false);
  assert.equal(calls.some(argv=>argv.includes('sha256sum')&&argv.includes(finalPath)&&argv.includes('1000:1000')&&argv.includes(temp)===false),true);
  assert.equal(calls.some(argv=>argv.includes('mv')),false);
  assert.equal(calls.some(argv=>argv.includes('rm')&&argv.includes(finalPath)),false);
  assert.equal(calls.some(argv=>['sh','bash','node'].includes(argv[0])||argv.includes(text)),false);
 }finally{f.cleanup();}
});
test('container install keeps the snapshot when the host file is swapped for the copy and restored',()=>{
 const f=scratch();try{
  const file=writeHost(f.root),text=body(),swapped=text.replace(secret,'host-file-secret-other');
  assert.equal(Buffer.byteLength(swapped),Buffer.byteLength(text));
  const {execFileSync}=containerExec(file,text,(command,args,opts)=>{
   fs.writeFileSync(file,swapped,{mode:0o600});
   assert.equal(Buffer.from(opts.input).equals(Buffer.from(text)),true);
   fs.writeFileSync(file,text,{mode:0o600});
  });
  const installed=runContainerPrivateInstall({docker:'docker',container:'qiwe-pilot-host',hostFile:file,destination:'/tmp/qiwe-live-pilot.private.json',execFileSync});
  assert.equal(installed.bytes,Buffer.byteLength(text));
 }finally{f.cleanup();}
});
test('container install mock checks the stdin byte count',()=>{
 const f=scratch();try{
  const file=writeHost(f.root),text=body();
  let stdinBytes=-1;
  const execFileSync=(command,args,options)=>{
   if(args.some(item=>String(item).includes('cat >'))){
    stdinBytes=options?.stdio?.[0]==='pipe'?Buffer.byteLength(options?.input??''):0;
    if(stdinBytes!==Buffer.byteLength(text))throw Error('stdin byte count '+stdinBytes);
    return '';
   }
   if(args.includes('sha256sum'))return `${digestOf(text)}  ${args.at(-1)}\n`;
   if(args.includes('stat'))return `1000 1000 600 1 ${Buffer.byteLength(text)}\n`;
   return '';
  };
  try{runContainerPrivateInstall({docker:'docker',container:'qiwe-pilot-host',hostFile:file,destination:'/tmp/qiwe-live-pilot.private.json',execFileSync});}
  catch(error){assert.equal(stdinBytes,Buffer.byteLength(text),error.message);throw error;}
  assert.equal(stdinBytes,Buffer.byteLength(text));
 }finally{f.cleanup();}
});
test('container install removes the destination after chown, stat, or post-copy snapshot failure',()=>{
 const f=scratch();try{
  const file=writeHost(f.root),text=body();
  for(const kind of process.platform==='win32'?['stat']:['stat','snapshot']){
   let copied=0,removed=0;
   let removedPath;
   assert.throws(()=>runContainerPrivateInstall({docker:'docker',container:'qiwe-pilot-host',hostFile:file,destination:'/tmp/qiwe-live-pilot.private.json',execFileSync(command,args){
    if(args.includes('rm')){removed++;removedPath=args.at(-1);return '';}
    if(args.some(item=>String(item).includes('cat >'))){copied++;return '';}
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
test('a directory at the container destination is refused and not linked inside',()=>{
 const f=scratch();try{
  const file=writeHost(f.root),text=body(),finalPath='/tmp/qiwe-live-pilot.private.json';
  let innerLink=false,removedFinal=0;
  assert.throws(()=>runContainerPrivateInstall({docker:'docker',container:'qiwe-pilot-host',hostFile:file,destination:finalPath,execFileSync(command,args){
   if(args.includes('sha256sum')&&args.includes(finalPath))return `${digestOf('directory')}\n`;
   if(args.includes('sha256sum'))return `${digestOf(text)}  temp\n`;
   if(args.includes('stat')&&args.includes(finalPath))return '1000 1000 755 2 4096\n';
   if(args.includes('stat'))return `1000 1000 600 1 ${Buffer.byteLength(text)}\n`;
   if(args.includes('ln')){
    assert.equal(args.includes('-f'),false);
    if(!args.includes('-T')){innerLink=true;return '';}
    const error=Error("'/tmp/qiwe-live-pilot.private.json' is a directory");
    error.status=1;error.stderr=error.message;throw error;
   }
   if(args.includes('rm')&&args.includes(finalPath))removedFinal++;
   return '';
  }}),error=>error.message==='PILOT_PRIVATE_DESTINATION_DIRECTORY'&&!error.message.includes(secret)&&!error.message.includes('directory'));
  assert.equal(innerLink,false);
  assert.equal(removedFinal,0);
 }finally{f.cleanup();}
});
test('a second container install refuses an existing destination without replacing it',()=>{
 const f=scratch();try{
  const file=writeHost(f.root),text=body(),finalPath='/tmp/qiwe-live-pilot.private.json';
  let installedBytes=null;
  const execFileSync=(command,args)=>{
   if(args.includes('sha256sum'))return `${digestOf(text)}  temp\n`;
   if(args.includes('stat'))return `1000 1000 600 1 ${Buffer.byteLength(text)}\n`;
   if(args.includes('ln')){
    if(installedBytes!==null){const error=Error('File exists');error.status=1;throw error;}
    installedBytes=text;return '';
   }
   if(args.includes('mv')){installedBytes='replaced';return '';}
   if(args.includes('rm')&&args.includes(finalPath))throw Error('removed '+secret);
   return '';
  };
  const options={docker:'docker',container:'qiwe-pilot-host',hostFile:file,destination:finalPath,execFileSync};
  assert.equal(runContainerPrivateInstall(options).bytes,Buffer.byteLength(text));
  assert.equal(installedBytes,text);
  assert.throws(()=>runContainerPrivateInstall(options),error=>error.message==='PILOT_PRIVATE_DESTINATION_INVALID'&&!error.message.includes(secret)&&!error.message.includes(text));
  assert.equal(installedBytes,text);
 }finally{f.cleanup();}
});
test('a failed docker cp does not remove a container path',()=>{
 const f=scratch();try{
  const file=writeHost(f.root);
  let removed=0;
  assert.throws(()=>runContainerPrivateInstall({docker:'docker',container:'qiwe-pilot-host',hostFile:file,destination:'/tmp/qiwe-live-pilot.private.json',execFileSync(command,args){
   if(args.includes('rm'))removed++;
   if(args.some(item=>String(item).includes('cat >')))throw Error('cp failed '+secret);
   return '';
  }}),error=>error.message==='PILOT_PRIVATE_CONTAINER_UNVERIFIED'&&!error.message.includes(secret));
  assert.equal(removed,0);
 }finally{f.cleanup();}
});
test('install does not replace or delete a final name that appears after the absence check',linuxOnly,()=>{
 const f=scratch();try{
  const destination=path.join(f.root,'container','secret.json'),occupant='OCCUPANT_NOT_OURS\n';
  fs.mkdirSync(path.dirname(destination));
  assert.throws(()=>installVerifiedPilotPrivateConfig({hostFile:writeHost(f.root),destination,beforePublish(){fs.writeFileSync(destination,occupant,{mode:0o600});}}),error=>error.message==='PILOT_PRIVATE_DESTINATION_INVALID'&&!error.message.includes(secret)&&!error.message.includes('OCCUPANT'));
  assert.equal(fs.readFileSync(destination,'utf8'),occupant);
  assert.deepEqual(fs.readdirSync(path.dirname(destination)),['secret.json']);
 }finally{f.cleanup();}
});
test('install rejects a symlink in an ancestor and does not write the target',linuxOnly,()=>{
 const f=scratch();try{
  const target=path.join(f.root,'evil-target','sub');
  fs.mkdirSync(target,{recursive:true});
  fs.symlinkSync(path.join(f.root,'evil-target'),path.join(f.root,'pilot-link'));
  const destination=path.join(f.root,'pilot-link','sub','secret.json');
  assert.throws(()=>installVerifiedPilotPrivateConfig({hostFile:writeHost(f.root),destination}),/PILOT_PRIVATE_DESTINATION_INVALID/);
  assert.equal(fs.existsSync(path.join(target,'secret.json')),false);
 }finally{f.cleanup();}
});
test('credential refusal names the variables and ignores Git config keys',()=>{
 const absent=path.join(os.tmpdir(),'qiwe-missing-private.json'),token='stitch-key-not-for-logs';
 assert.throws(()=>assertIsolatedSyntheticClosed({PATH:'/usr/bin',STITCH_API_KEY:token,DEEPSEEK_API_KEY:'other-secret',GIT_CONFIG_KEY_0:'credential.helper',GIT_CONFIG_KEY_1:'http.extraheader'},absent,{root:os.tmpdir()}),error=>error.message==='ISOLATED_SYNTHETIC_REAL_CREDENTIAL'&&JSON.stringify(error.envNames)===JSON.stringify(['DEEPSEEK_API_KEY','STITCH_API_KEY'])&&!error.message.includes(token)&&!JSON.stringify(error.envNames).includes(token));
 assert.doesNotThrow(()=>assertIsolatedSyntheticClosed({PATH:'/usr/bin',GIT_CONFIG_KEY_0:'credential.helper',GIT_CONFIG_VALUE_0:'not-a-name-match'},absent,{root:os.tmpdir()}));
});
test('PowerShell 5 probe output is SID JSON even when the bytes are UTF-16',()=>{
 const payload='{"currentSid":"S-1-5-21-9-8-7-1001","reparse":false,"aces":[{"sid":"S-1-5-21-9-8-7-1001","type":"Allow","inherited":false}]}';
 const parsed=parseWindowsAclProbe(Buffer.from(payload,'utf8'));
 assert.equal(parsed.currentSid,'S-1-5-21-9-8-7-1001');
 const wide=Buffer.concat([Buffer.from([0xFF,0xFE]),Buffer.from(payload,'utf16le')]);
 assert.equal(parseWindowsAclProbe(wide).aces[0].sid,'S-1-5-21-9-8-7-1001');
 const args=windowsAclProbeArgs();
 const decoded=Buffer.from(args.at(-1),'base64').toString('utf16le');
 assert.equal(args[2],'-EncodedCommand');
 assert.equal(decoded,windowsAclProbeScript);
 assert.match(decoded,/\$p=\$env:QIWE_ACL_PATH/);
 assert.match(decoded,/Get-Acl -LiteralPath \$p/);
 assert.match(decoded,/WindowsIdentity/);
 assert.equal(decoded.includes('私密'),false);
});
test('staging a Windows private file grants the SID and stays inside the profile',()=>{
 const f=scratch();try{
  const home=path.join(f.root,'why的私密花园'),source=writeHost(f.root),calls=[];
  fs.mkdirSync(home);
  const sid='S-1-5-21-9-8-7-1001';
  const staged=stageWindowsPrivateFile({platform:'win32',homedir:home,source,currentSid:sid,execFileSync:(command,args)=>{calls.push([command,...args]);}});
  assert.equal(staged.destination,path.join(home,'qiwe-pilot','private.json'));
  assert.equal(fs.readFileSync(staged.destination,'utf8'),body());
  const grant=calls.find(argv=>argv[0]==='icacls');
  assert.deepEqual(grant.slice(2),['/inheritance:r','/grant:r',`*${sid}:(R)`]);
  assert.equal(grant.some(item=>item.includes(':(R)')&&!item.startsWith('*S-1-')),false);
  assert.throws(()=>stageWindowsPrivateFile({platform:'linux',homedir:home,source,currentSid:sid,execFileSync(){}}),/PILOT_STAGE_WINDOWS_ONLY/);
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
