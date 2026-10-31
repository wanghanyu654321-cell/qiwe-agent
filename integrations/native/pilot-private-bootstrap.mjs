import fs from 'node:fs';
import path from 'node:path';
import {validatePilotPrivateInput} from './frontagent-controlled-live-entry.mjs';

export const PILOT_PRIVATE_CONFIG_PATH='/tmp/qiwe-live-pilot.private.json';
export const REAL_CREDENTIAL_ENV_NAMES=Object.freeze(['ANTHROPIC_API_KEY','ANTHROPIC_AUTH_TOKEN','CLAUDE_CODE_OAUTH_TOKEN','WECOM_BOT_ID','WECOM_BOT_SECRET','WECOM_CORP_ID']);
const containerUser=1000,privateMode=0o600,maxBytes=16384;
const fail=code=>{throw Error(code);};
function freeze(value){if(value&&typeof value==='object'&&!Object.isFrozen(value)){for(const item of Object.values(value))freeze(item);Object.freeze(value);}return value;}
function present(file){
 if(typeof file!=='string'||!path.isAbsolute(file))fail('ISOLATED_SYNTHETIC_INPUT_INVALID');
 try{fs.lstatSync(file);return true;}catch(error){if(error?.code==='ENOENT')return false;fail('ISOLATED_SYNTHETIC_REAL_CREDENTIAL');}
}
/** Real pilot credentials and the isolated-synthetic entry cannot be combined. */
export function assertIsolatedSyntheticClosed(env,privateConfigPath){
 if(!env||env.QIWE_CONTROLLED_REAL_PILOT==='1'||REAL_CREDENTIAL_ENV_NAMES.some(name=>typeof env[name]==='string'&&env[name].length>0))fail('ISOLATED_SYNTHETIC_REAL_CREDENTIAL');
 const files=new Set([PILOT_PRIVATE_CONFIG_PATH,privateConfigPath]);
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
export function installVerifiedPilotPrivateConfig({hostFile,destination,beforePublish}={}){
 if(typeof destination!=='string'||!path.isAbsolute(destination)||destination===hostFile)fail('PILOT_PRIVATE_DESTINATION_INVALID');
 const parent=path.dirname(destination);
 let parentStat;try{parentStat=fs.lstatSync(parent);}catch{fail('PILOT_PRIVATE_DESTINATION_INVALID');}
 if(parentStat.isSymbolicLink()||!parentStat.isDirectory())fail('PILOT_PRIVATE_DESTINATION_INVALID');
 try{fs.lstatSync(destination);fail('PILOT_PRIVATE_DESTINATION_INVALID');}catch(error){if(error?.code!=='ENOENT')throw error;}
 let opened,out;
 try{
  opened=snapshotHostFile(hostFile);
  if(typeof beforePublish==='function')beforePublish();
  if(!reread(opened.fd,opened.raw))fail('PILOT_PRIVATE_INPUT_CHANGED');
  out=fs.openSync(destination,fs.constants.O_RDWR|fs.constants.O_CREAT|fs.constants.O_EXCL|fs.constants.O_NOFOLLOW,privateMode);
  let written=0;while(written<opened.raw.length){const count=fs.writeSync(out,opened.raw,written,opened.raw.length-written,written);if(count===0)fail('PILOT_PRIVATE_OWNERSHIP_UNVERIFIED');written+=count;}
  fs.fchownSync(out,containerUser,containerUser);
  fs.fchmodSync(out,privateMode);
  fs.fsyncSync(out);
  if(!reread(opened.fd,opened.raw))fail('PILOT_PRIVATE_INPUT_CHANGED');
  const stat=fs.fstatSync(out);
  if(!stat.isFile()||stat.nlink!==1||stat.uid!==containerUser||stat.gid!==containerUser||(stat.mode&0o777)!==privateMode||stat.size!==opened.raw.length||!readExact(out,opened.raw.length).equals(opened.raw))fail('PILOT_PRIVATE_OWNERSHIP_UNVERIFIED');
  return freeze({uid:containerUser,gid:containerUser,mode:privateMode,nlink:1,bytes:opened.raw.length});
 }catch(error){
  if(out!==undefined){try{fs.closeSync(out);}catch{}out=undefined;try{fs.unlinkSync(destination);}catch{}}
  if(error?.code==='ELOOP')fail('PILOT_PRIVATE_FILE_UNSAFE');
  throw error;
 }finally{if(out!==undefined)fs.closeSync(out);if(opened)fs.closeSync(opened.fd);}
}
export function containerPrivateInstallPlan({docker,container,hostFile,destination}={}){
 if(docker!=='docker'&&(typeof docker!=='string'||!path.isAbsolute(docker)))fail('PILOT_PRIVATE_CONTAINER_UNVERIFIED');
 if(!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/.test(container??'')||destination!==PILOT_PRIVATE_CONFIG_PATH)fail('PILOT_PRIVATE_CONTAINER_UNVERIFIED');
 if(typeof hostFile!=='string'||!path.isAbsolute(hostFile))fail('PILOT_PRIVATE_FILE_UNSAFE');
 return [[docker,'cp','--',hostFile,container+':'+destination],[docker,'exec','--user','0:0',container,'chown','1000:1000',destination],[docker,'exec','--user','0:0',container,'chmod','600',destination],[docker,'exec','--user','1000:1000',container,'stat','-c','%u %g %a %h %s',destination]];
}
export function runContainerPrivateInstall(options){
 const opened=snapshotHostFile(options?.hostFile);
 fs.closeSync(opened.fd);
 const commands=containerPrivateInstallPlan(options);
 const execFileSync=options.execFileSync;if(typeof execFileSync!=='function')fail('PILOT_PRIVATE_CONTAINER_UNVERIFIED');
 let statText='';
 for(const [command,...args] of commands){
  let output;try{output=execFileSync(command,args,{encoding:'utf8',timeout:20000,env:{PATH:process.env.PATH??''},stdio:['ignore','pipe','pipe']});}catch{fail('PILOT_PRIVATE_CONTAINER_UNVERIFIED');}
  if(args.includes('stat'))statText=String(output??'');
 }
 const match=/^1000 1000 600 1 (\d+)\n?$/.exec(statText);
 if(!match||Number(match[1])!==opened.raw.length)fail('PILOT_PRIVATE_CONTAINER_UNVERIFIED');
 const again=snapshotHostFile(options.hostFile);
 fs.closeSync(again.fd);
 if(!again.raw.equals(opened.raw)){
  try{execFileSync(commands[0][0],['exec','--user','0:0',options.container,'rm','-f',PILOT_PRIVATE_CONFIG_PATH],{encoding:'utf8',timeout:20000,env:{PATH:process.env.PATH??''},stdio:['ignore','pipe','pipe']});}catch{fail('PILOT_PRIVATE_CONTAINER_UNVERIFIED');}
  fail('PILOT_PRIVATE_INPUT_CHANGED');
 }
 return freeze({uid:containerUser,gid:containerUser,mode:privateMode,nlink:1,bytes:opened.raw.length});
}
