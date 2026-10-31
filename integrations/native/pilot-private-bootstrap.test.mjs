import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {installVerifiedPilotPrivateConfig,readHostPilotPrivateFile,runContainerPrivateInstall} from './pilot-private-bootstrap.mjs';

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

test('container install plan copies by path and verifies uid 1000 mode 0600 without putting bytes on argv',()=>{
 const f=scratch();try{
  const file=writeHost(f.root);
  const calls=[];
  const installed=runContainerPrivateInstall({docker:'docker',container:'qiwe-pilot-host',hostFile:file,destination:'/tmp/qiwe-live-pilot.private.json',execFileSync(command,args){
   calls.push([command,...args]);
   if(args.includes('stat'))return `1000 1000 600 1 ${Buffer.byteLength(body())}\n`;
   return '';
  }});
  assert.deepEqual(installed,{uid:1000,gid:1000,mode:0o600,nlink:1,bytes:Buffer.byteLength(body())});
  const flat=JSON.stringify(calls);
  assert.equal(flat.includes(secret)||flat.includes(modelKey),false);
  assert.equal(calls.some(argv=>argv.includes('cp')&&argv.includes(file)&&argv.includes('qiwe-pilot-host:/tmp/qiwe-live-pilot.private.json')),true);
  assert.equal(calls.some(argv=>argv.includes('chown')&&argv.includes('1000:1000')),true);
  assert.equal(calls.some(argv=>argv.includes('chmod')&&argv.includes('600')),true);
  assert.equal(calls.some(argv=>['sh','bash','node'].includes(argv[0])||argv.includes(body())),false);
 }finally{f.cleanup();}
});
