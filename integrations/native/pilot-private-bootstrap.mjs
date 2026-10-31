import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {randomBytes,createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {validatePilotPrivateInput} from './frontagent-controlled-live-entry.mjs';

const projectRoot=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../..');
const liveRelative=Object.freeze(['.local/live-model/.env','.local/live-channel/.env']);
export const PILOT_PRIVATE_CONFIG_PATH='/tmp/qiwe-live-pilot.private.json';
export const LIVE_CREDENTIAL_FILES=Object.freeze(liveRelative.map(relative=>path.join(projectRoot,relative)));
export const REAL_CREDENTIAL_ENV_NAMES=Object.freeze(['ANTHROPIC_API_KEY','ANTHROPIC_AUTH_TOKEN','CLAUDE_CODE_OAUTH_TOKEN','WECOM_BOT_ID','WECOM_BOT_SECRET','WECOM_CORP_ID']);
const containerUser=1000,privateMode=0o600,maxBytes=16384;
const fail=code=>{throw Error(code);};
function freeze(value){if(value&&typeof value==='object'&&!Object.isFrozen(value)){for(const item of Object.values(value))freeze(item);Object.freeze(value);}return value;}
function present(file){
 if(typeof file!=='string'||!path.isAbsolute(file))fail('ISOLATED_SYNTHETIC_INPUT_INVALID');
 try{fs.lstatSync(file);return true;}catch(error){if(error?.code==='ENOENT')return false;fail('ISOLATED_SYNTHETIC_REAL_CREDENTIAL');}
}
/** Real pilot credentials and the isolated-synthetic entry cannot be combined. */
export function assertIsolatedSyntheticClosed(env,privateConfigPath,options){
 if(!env||env.QIWE_CONTROLLED_REAL_PILOT==='1'||REAL_CREDENTIAL_ENV_NAMES.some(name=>typeof env[name]==='string'&&env[name].length>0))fail('ISOLATED_SYNTHETIC_REAL_CREDENTIAL');
 const root=options?.root??projectRoot;
 if(options?.root!==undefined&&(typeof root!=='string'||!path.isAbsolute(root)))fail('ISOLATED_SYNTHETIC_INPUT_INVALID');
 const files=new Set([PILOT_PRIVATE_CONFIG_PATH,privateConfigPath,...liveRelative.map(relative=>path.join(root,relative))]);
 for(const file of files)if(present(file))fail('ISOLATED_SYNTHETIC_REAL_CREDENTIAL');
}
function readExact(fd,size){
 const raw=Buffer.alloc(size);let offset=0;
 while(offset<raw.length){const count=fs.readSync(fd,raw,offset,raw.length-offset,offset);if(count===0)break;offset+=count;}
 if(offset!==raw.length)fail('PILOT_PRIVATE_FILE_UNSAFE');
 return raw;
}
function snapshotHostFile(hostFile){
 if(typeof hostFile!=='string'||!path.isAbsolute(hostFile))fail('PILOT_PRIVATE_FILE_UNSAFE');
 let fd;try{fd=fs.openSync(hostFile,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW);}catch{fail('PILOT_PRIVATE_FILE_UNSAFE');}
 try{
  const stat=fs.fstatSync(fd);
  if(!stat.isFile()||stat.nlink!==1||stat.size<=0||stat.size>maxBytes||(stat.mode&0o777)!==privateMode)fail('PILOT_PRIVATE_FILE_UNSAFE');
  const raw=readExact(fd,stat.size);
  let parsed;try{parsed=JSON.parse(raw.toString('utf8'));}catch{fail('CONTROLLED_REAL_PRIVATE_INPUT_INVALID');}
  return {fd,raw,accepted:validatePilotPrivateInput(parsed)};
 }catch(error){fs.closeSync(fd);throw error;}
}
export function readHostPilotPrivateFile(hostFile){
 const opened=snapshotHostFile(hostFile);
 try{return freeze(structuredClone(opened.accepted));}
 finally{fs.closeSync(opened.fd);}
}
function reread(fd,raw){
 const stat=fs.fstatSync(fd);
 if(!stat.isFile()||stat.nlink!==1||stat.size!==raw.length)return false;
 return readExact(fd,raw.length).equals(raw);
}
function openAt(parentFd,name,flags,mode){
 const target=`/proc/self/fd/${parentFd}/${name}`,full=flags|fs.constants.O_NOFOLLOW;
 return mode===undefined?fs.openSync(target,full):fs.openSync(target,full,mode);
}
function destinationDirectory(destination){
 if(typeof destination!=='string'||!path.isAbsolute(destination)||destination===path.parse(destination).root)fail('PILOT_PRIVATE_DESTINATION_INVALID');
 const parts=destination.split(path.sep).filter(Boolean),name=parts.pop();
 if(!name||name==='.'||name==='..'||parts.some(part=>!part||part==='.'||part==='..'))fail('PILOT_PRIVATE_DESTINATION_INVALID');
 const fds=[];
 try{
  let dirFd=fs.openSync(path.parse(destination).root,fs.constants.O_RDONLY|fs.constants.O_DIRECTORY);
  fds.push(dirFd);
  for(const part of parts){
   try{dirFd=openAt(dirFd,part,fs.constants.O_RDONLY|fs.constants.O_DIRECTORY);}catch{fail('PILOT_PRIVATE_DESTINATION_INVALID');}
   fds.push(dirFd);
  }
  try{const existing=openAt(dirFd,name,fs.constants.O_RDONLY);fs.closeSync(existing);fail('PILOT_PRIVATE_DESTINATION_INVALID');}
  catch(error){if(error?.message==='PILOT_PRIVATE_DESTINATION_INVALID'||error?.code!=='ENOENT')fail('PILOT_PRIVATE_DESTINATION_INVALID');}
  return {dirFd,name,fds};
 }catch(error){for(const fd of fds)try{fs.closeSync(fd);}catch{}throw error;}
}
function writeStaged(dirFd,raw){
 const stage=`.qiwe-private-${randomBytes(8).toString('hex')}`;
 const fd=openAt(dirFd,stage,fs.constants.O_RDWR|fs.constants.O_CREAT|fs.constants.O_EXCL,privateMode);
 let written=0;
 try{
  while(written<raw.length){const count=fs.writeSync(fd,raw,written,raw.length-written,written);if(count===0)fail('PILOT_PRIVATE_OWNERSHIP_UNVERIFIED');written+=count;}
  fs.fchownSync(fd,containerUser,containerUser);fs.fchmodSync(fd,privateMode);fs.fsyncSync(fd);
  if(!readExact(fd,raw.length).equals(raw))fail('PILOT_PRIVATE_OWNERSHIP_UNVERIFIED');
  const stat=fs.fstatSync(fd);
  return {name:stage,dev:String(stat.dev),ino:String(stat.ino)};
 }catch(error){try{fs.closeSync(fd);}catch{}try{fs.unlinkSync(`/proc/self/fd/${dirFd}/${stage}`);}catch{}throw error;}
 finally{if(fd!==undefined)try{fs.closeSync(fd);}catch{}}
}
export function installVerifiedPilotPrivateConfig({hostFile,destination,beforePublish}={}){
 if(destination===hostFile)fail('PILOT_PRIVATE_DESTINATION_INVALID');
 const located=destinationDirectory(destination);
 let opened,stageName,owned,linked=false;
 const stagePath=()=>`/proc/self/fd/${located.dirFd}/${stageName}`,finalPath=()=>`/proc/self/fd/${located.dirFd}/${located.name}`;
 try{
  opened=snapshotHostFile(hostFile);
  if(typeof beforePublish==='function')beforePublish();
  if(!reread(opened.fd,opened.raw))fail('PILOT_PRIVATE_INPUT_CHANGED');
  const staged=writeStaged(located.dirFd,opened.raw);
  stageName=staged.name;owned={dev:staged.dev,ino:staged.ino};
  if(!reread(opened.fd,opened.raw))fail('PILOT_PRIVATE_INPUT_CHANGED');
  try{fs.linkSync(stagePath(),finalPath());}catch(error){if(error?.code==='EEXIST')fail('PILOT_PRIVATE_DESTINATION_INVALID');throw error;}
  linked=true;
  const same=stat=>String(stat.dev)===owned.dev&&String(stat.ino)===owned.ino;
  const published=openAt(located.dirFd,located.name,fs.constants.O_RDONLY);
  try{
   const stat=fs.fstatSync(published);
   if(!same(stat)||!stat.isFile()||stat.uid!==containerUser||stat.gid!==containerUser||(stat.mode&0o777)!==privateMode||stat.size!==opened.raw.length||!readExact(published,opened.raw.length).equals(opened.raw))fail('PILOT_PRIVATE_OWNERSHIP_UNVERIFIED');
  }finally{fs.closeSync(published);}
  fs.unlinkSync(stagePath());stageName=undefined;fs.fsyncSync(located.dirFd);
  const confirmed=openAt(located.dirFd,located.name,fs.constants.O_RDONLY);
  try{
   const stat=fs.fstatSync(confirmed);
   if(!same(stat)||stat.nlink!==1||(stat.mode&0o777)!==privateMode||!readExact(confirmed,opened.raw.length).equals(opened.raw))fail('PILOT_PRIVATE_OWNERSHIP_UNVERIFIED');
  }finally{fs.closeSync(confirmed);}
  return freeze({uid:containerUser,gid:containerUser,mode:privateMode,nlink:1,bytes:opened.raw.length});
 }catch(error){
  if(stageName!==undefined)try{fs.unlinkSync(stagePath());}catch{}
  if(linked&&owned)try{const fd=openAt(located.dirFd,located.name,fs.constants.O_RDONLY);try{const stat=fs.fstatSync(fd);if(String(stat.dev)===owned.dev&&String(stat.ino)===owned.ino)fs.unlinkSync(finalPath());}finally{fs.closeSync(fd);}}catch{}
  if(error?.code==='ELOOP'||error?.code==='ENOTDIR')fail('PILOT_PRIVATE_DESTINATION_INVALID');
  throw error;
 }finally{if(opened)fs.closeSync(opened.fd);for(const fd of located.fds)try{fs.closeSync(fd);}catch{}}
}
function writeSnapshotCopy(raw){
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'qiwe-private-snapshot-')),file=path.join(dir,'snapshot');
 let fd;
 try{
  fd=fs.openSync(file,fs.constants.O_RDWR|fs.constants.O_CREAT|fs.constants.O_EXCL|fs.constants.O_NOFOLLOW,privateMode);
  let written=0;while(written<raw.length){const count=fs.writeSync(fd,raw,written,raw.length-written,written);if(count===0)fail('PILOT_PRIVATE_CONTAINER_UNVERIFIED');written+=count;}
  fs.fchmodSync(fd,privateMode);fs.fsyncSync(fd);
  if(!readExact(fd,raw.length).equals(raw))fail('PILOT_PRIVATE_CONTAINER_UNVERIFIED');
  return {dir,file};
 }catch(error){fs.rmSync(dir,{recursive:true,force:true});throw error;}
 finally{if(fd!==undefined)try{fs.closeSync(fd);}catch{}}
}
function invoke(execFileSync,command,args){
 try{return execFileSync(command,args,{encoding:'utf8',timeout:20000,env:{PATH:process.env.PATH??''},stdio:['ignore','pipe','pipe']});}
 catch{fail('PILOT_PRIVATE_CONTAINER_UNVERIFIED');}
}
export function containerPrivateInstallPlan({docker,container,snapshotFile,containerTemp,destination}={}){
 if(docker!=='docker'&&(typeof docker!=='string'||!path.isAbsolute(docker)))fail('PILOT_PRIVATE_CONTAINER_UNVERIFIED');
 if(!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/.test(container??'')||destination!==PILOT_PRIVATE_CONFIG_PATH)fail('PILOT_PRIVATE_CONTAINER_UNVERIFIED');
 if(!/^\/tmp\/qiwe-private-[a-f0-9]{16}$/.test(containerTemp??'')||typeof snapshotFile!=='string'||!path.isAbsolute(snapshotFile))fail('PILOT_PRIVATE_CONTAINER_UNVERIFIED');
 return [[docker,'cp','--',snapshotFile,container+':'+containerTemp],[docker,'exec','--user','0:0',container,'chown','1000:1000',containerTemp],[docker,'exec','--user','0:0',container,'chmod','600',containerTemp],[docker,'exec','--user','1000:1000',container,'sha256sum',containerTemp],[docker,'exec','--user','1000:1000',container,'stat','-c','%u %g %a %h %s',containerTemp],[docker,'exec','--user','0:0',container,'mv',containerTemp,destination]];
}
export function runContainerPrivateInstall(options){
 const opened=snapshotHostFile(options?.hostFile);
 let snapshot;
 try{
  if(!reread(opened.fd,opened.raw))fail('PILOT_PRIVATE_INPUT_CHANGED');
  snapshot=writeSnapshotCopy(opened.raw);
  const containerTemp=`/tmp/qiwe-private-${randomBytes(8).toString('hex')}`;
  const commands=containerPrivateInstallPlan({docker:options?.docker,container:options?.container,snapshotFile:snapshot.file,containerTemp,destination:options?.destination});
  const execFileSync=options?.execFileSync;if(typeof execFileSync!=='function')fail('PILOT_PRIVATE_CONTAINER_UNVERIFIED');
  const hash=createHash('sha256').update(opened.raw).digest('hex');
  const prepare=commands.filter(argv=>!argv.includes('mv')),move=commands.find(argv=>argv.includes('mv'));
  let copied=false;
  try{
   let statText='',hashText='';
   for(const [command,...args] of prepare){
    const output=invoke(execFileSync,command,args);
    if(args.includes('cp'))copied=true;
    if(args.includes('sha256sum'))hashText=String(output??'');
    if(args.includes('stat'))statText=String(output??'');
   }
   const hashed=/^([a-f0-9]{64})(?:\s|$)/.exec(hashText),measured=/^1000 1000 600 1 (\d+)\n?$/.exec(statText);
   if(!hashed||hashed[1]!==hash||!measured||Number(measured[1])!==opened.raw.length)fail('PILOT_PRIVATE_CONTAINER_UNVERIFIED');
   const again=snapshotHostFile(options.hostFile);
   try{if(!again.raw.equals(opened.raw))fail('PILOT_PRIVATE_INPUT_CHANGED');}
   finally{fs.closeSync(again.fd);}
   invoke(execFileSync,move[0],move.slice(1));
   return freeze({uid:containerUser,gid:containerUser,mode:privateMode,nlink:1,bytes:opened.raw.length});
  }catch(error){
   if(copied)invoke(execFileSync,commands[0][0],['exec','--user','0:0',options.container,'rm','-f',containerTemp]);
   throw error;
  }
 }finally{fs.closeSync(opened.fd);if(snapshot)fs.rmSync(snapshot.dir,{recursive:true,force:true});}
}
