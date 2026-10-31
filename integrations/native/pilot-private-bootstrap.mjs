import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {randomBytes,createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {validatePilotPrivateInput} from './frontagent-controlled-live-entry.mjs';

const projectRoot=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../..');
const liveRelative=Object.freeze(['.local/live-model/.env','.local/live-channel/.env']);
export const PILOT_PRIVATE_CONFIG_PATH='/tmp/qiwe-live-pilot.private.json';
export const LIVE_CREDENTIAL_FILES=Object.freeze(liveRelative.map(relative=>path.join(projectRoot,relative)));
export const REAL_CREDENTIAL_ENV_NAMES=Object.freeze(['ANTHROPIC_API_KEY','ANTHROPIC_AUTH_TOKEN','CLAUDE_CODE_OAUTH_TOKEN','WECOM_BOT_ID','WECOM_BOT_SECRET','WECOM_CORP_ID']);
const credentialPrefixes=['OPENAI_','GEMINI_','GOOGLE_GEMINI_','DEEPSEEK_','AWS_','WECOM_'];
const credentialSuffixes=['API_KEY','_TOKEN','SECRET','SECRET_KEY','ACCESS_KEY_ID','PASSWORD','_API_BASE','_BASE_URL','CUSTOM_HEADERS'];
const syntheticQiweAllowlist=new Set(['QIWE_PILOT_ENTRY_MODE','QIWE_SYNTHETIC_DATA_DIR','QIWE_SYNTHETIC_FOLDER']);
function credentialEnvName(name){
 const upper=String(name).toUpperCase();
 if(/^GIT_CONFIG_KEY_[0-9]+$/.test(upper))return false;
 if(syntheticQiweAllowlist.has(upper))return false;
 if(upper.startsWith('ANTHROPIC_')&&upper!=='ANTHROPIC_MODEL')return true;
 if(credentialPrefixes.some(prefix=>upper.startsWith(prefix))||REAL_CREDENTIAL_ENV_NAMES.includes(upper))return true;
 return credentialSuffixes.some(suffix=>upper.endsWith(suffix));
}
const containerUser=1000,privateMode=0o600,maxBytes=16384;
const fail=code=>{throw Error(code);};
function freeze(value){if(value&&typeof value==='object'&&!Object.isFrozen(value)){for(const item of Object.values(value))freeze(item);Object.freeze(value);}return value;}
function present(file){
 if(typeof file!=='string'||!path.isAbsolute(file))fail('ISOLATED_SYNTHETIC_INPUT_INVALID');
 try{fs.lstatSync(file);return true;}catch(error){if(error?.code==='ENOENT')return false;fail('ISOLATED_SYNTHETIC_REAL_CREDENTIAL');}
}
function refuseSynthetic(names){
 const error=Error('ISOLATED_SYNTHETIC_REAL_CREDENTIAL');
 error.envNames=Object.freeze([...names].sort());
 throw error;
}
/** Real pilot credentials and the isolated-synthetic entry cannot be combined. */
export function assertIsolatedSyntheticClosed(env,privateConfigPath,options){
 if(!env||env.QIWE_CONTROLLED_REAL_PILOT==='1')refuseSynthetic(env?.QIWE_CONTROLLED_REAL_PILOT==='1'?['QIWE_CONTROLLED_REAL_PILOT']:[]);
 const names=Object.entries(env).filter(([name,value])=>typeof value==='string'&&value.trim().length>0&&credentialEnvName(name)).map(([name])=>name);
 if(names.length)refuseSynthetic(names);
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
const windowsForbiddenSids=new Set(['S-1-1-0','S-1-5-11','S-1-5-32-545']);
const windowsSystemSid='S-1-5-18',windowsAdministratorsSid='S-1-5-32-544';
/** Allow ACEs may name only the current user SID, SYSTEM, or Administrators. Names are ignored so a localized path cannot satisfy the check. */
export function windowsAllowAces(aces,currentSid){
 if(typeof currentSid!=='string'||!/^S-1-[0-9-]+$/.test(currentSid)||windowsForbiddenSids.has(currentSid))return false;
 if(!Array.isArray(aces)||aces.length<1||aces.length>16)return false;
 const allowed=new Set([currentSid,windowsSystemSid,windowsAdministratorsSid]);
 let userAllow=false;
 for(const ace of aces){
  if(!ace||ace.inherited===true||ace.type!=='Allow'||typeof ace.sid!=='string'||!/^S-1-[0-9-]+$/.test(ace.sid)||!allowed.has(ace.sid))return false;
  if(ace.sid===currentSid)userAllow=true;
 }
 return userAllow;
}
export const windowsAclProbeScript="$ErrorActionPreference='Stop'; $p=$env:QIWE_ACL_PATH; $acl=Get-Acl -LiteralPath $p; $item=Get-Item -LiteralPath $p -Force; $reparse=[bool](($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0); $current=[System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value; $rows=foreach($ace in @($acl.Access)){ $sid=$ace.IdentityReference.Translate([System.Security.Principal.SecurityIdentifier]).Value; [pscustomobject]@{sid=$sid; type=[string]$ace.AccessControlType; inherited=[bool]$ace.IsInherited} }; @{currentSid=$current; reparse=$reparse; aces=@($rows)} | ConvertTo-Json -Compress";
export function windowsAclProbeArgs(script=windowsAclProbeScript){
 return ['-NoProfile','-NonInteractive','-EncodedCommand',Buffer.from(script,'utf16le').toString('base64')];
}
export function parseWindowsAclProbe(output){
 const buffer=Buffer.isBuffer(output)?output:Buffer.from(String(output??''),'utf8');
 const utf16=buffer.length>=2&&(buffer[0]===0xFF&&buffer[1]===0xFE||buffer[1]===0);
 const text=(utf16?buffer.subarray(buffer[0]===0xFF?2:0).toString('utf16le'):buffer.toString('utf8')).replace(/^\uFEFF/,'');
 const start=text.indexOf('{'),end=text.lastIndexOf('}');
 if(start<0||end<start)return null;
 let parsed;try{parsed=JSON.parse(text.slice(start,end+1));}catch{return null;}
 const aces=Array.isArray(parsed.aces)?parsed.aces:parsed.aces?[parsed.aces]:[];
 if(typeof parsed.currentSid!=='string'||!/^S-1-[0-9-]+$/.test(parsed.currentSid))return null;
 return {aces,currentSid:parsed.currentSid,reparsePoint:parsed.reparse===true};
}
function readWindowsAcl(hostFile,run){
 try{
  const env={SystemRoot:process.env.SystemRoot??'',WINDIR:process.env.WINDIR??'',PATH:process.env.PATH??'',QIWE_ACL_PATH:hostFile};
  const output=(run??execFileSync)('powershell.exe',windowsAclProbeArgs(),{encoding:'buffer',timeout:15000,windowsHide:true,env});
  return parseWindowsAclProbe(output);
 }catch{return null;}
}
function rejectPrivate(reason){
 const error=Error('PILOT_PRIVATE_FILE_UNSAFE');
 error.reason=reason;
 throw error;
}
export function grantWindowsSid(target,sid,run){
 if(typeof target!=='string'||!path.isAbsolute(target)||!/^S-1-[0-9-]+$/.test(sid??''))rejectPrivate('sid');
 (run??execFileSync)('icacls',[target,'/inheritance:r','/grant:r',`*${sid}:(R)`],{windowsHide:true,stdio:'ignore'});
}
export function createPilotScratch(options={}){
 const platform=options.platform??process.platform;
 if(platform!=='win32')return fs.mkdtempSync(path.join(options.tmpdir??os.tmpdir(),'qiwe-launch-'));
 const home=options.homedir??os.homedir();
 if(typeof home!=='string'||!path.isAbsolute(home))rejectPrivate('home');
 const root=path.join(home,'qiwe-pilot');
 fs.mkdirSync(root,{recursive:true});
 return fs.mkdtempSync(path.join(root,'launch-'));
}
function readPrivateBytes(source){
 if(typeof source!=='string'||!path.isAbsolute(source))rejectPrivate('path');
 let fd;try{fd=fs.openSync(source,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW);}catch{rejectPrivate('open');}
 try{
  const stat=fs.fstatSync(fd);
  if(!stat.isFile())rejectPrivate('type');
  if(stat.size<=0||stat.size>maxBytes)rejectPrivate('size');
  const raw=readExact(fd,stat.size);
  let parsed;try{parsed=JSON.parse(raw.toString('utf8'));}catch{fail('CONTROLLED_REAL_PRIVATE_INPUT_INVALID');}
  validatePilotPrivateInput(parsed);
  return raw;
 }finally{fs.closeSync(fd);}
}
/** Copy a private file under the user profile and grant only that user's SID read access. */
export function stageWindowsPrivateFile(options={}){
 if((options.platform??process.platform)!=='win32')throw Error('PILOT_STAGE_WINDOWS_ONLY');
 const home=options.homedir??os.homedir();
 const destination=options.destination??path.join(home,'qiwe-pilot','private.json');
 if(typeof home!=='string'||!path.isAbsolute(home)||typeof destination!=='string'||!path.isAbsolute(destination))rejectPrivate('home');
 const parent=path.dirname(destination),prefix=home.endsWith(path.sep)?home:home+path.sep;
 if(parent!==home&&!parent.startsWith(prefix))rejectPrivate('home');
 const raw=readPrivateBytes(options.source);
 fs.mkdirSync(parent,{recursive:true});
 fs.writeFileSync(destination,raw);
 const run=options.execFileSync??execFileSync;
 grantWindowsSid(destination,options.currentSid??currentWindowsSid(run),run);
 return {destination};
}
export function sealWindowsPlaceholder(file,options={}){
 if((options.platform??process.platform)!=='win32')return file;
 grantWindowsSid(file,options.currentSid??currentWindowsSid(options.execFileSync),options.execFileSync);
 return file;
}
function currentWindowsSid(run){
 const output=(run??execFileSync)('powershell.exe',windowsAclProbeArgs('[System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value'),{encoding:'utf8',timeout:15000,windowsHide:true});
 const sid=/S-1-[0-9-]+/.exec(String(output))?.[0];
 if(!sid)rejectPrivate('sid');
 return sid;
}
/** Windows node reports NTFS mode 0666. Accept a regular file inside the user home when every explicit Allow ACE SID is the current user, SYSTEM, or Administrators. Linux still requires mode 0600. */
function windowsPrivateFileAccepted(hostFile,stat,options={}){
 if((options.platform??process.platform)!=='win32')return false;
 if(!stat.isFile()||stat.nlink!==1||stat.size<=0||stat.size>maxBytes)return false;
 let listed;try{listed=fs.lstatSync(hostFile);}catch{rejectPrivate('open');}
 if(listed.isSymbolicLink())rejectPrivate('reparse');
 if(!listed.isFile()||listed.nlink!==1)return false;
 const home=options.homedir??os.homedir();
 if(typeof home!=='string'||!path.isAbsolute(home))rejectPrivate('home');
 let real;try{real=(options.realpath??fs.realpathSync)(hostFile);}catch{rejectPrivate('home');}
 const parent=path.dirname(real),prefix=home.endsWith(path.sep)?home:home+path.sep;
 if(parent!==home&&!parent.startsWith(prefix))rejectPrivate('home');
 let aces=options.aces,currentSid=options.currentSid,reparsePoint=options.reparsePoint===true;
 if(aces===undefined){if((options.platform??process.platform)!=='win32')rejectPrivate('probe');const probed=readWindowsAcl(hostFile,options.aclExec);if(!probed)rejectPrivate('probe');aces=probed.aces;currentSid=probed.currentSid;reparsePoint=probed.reparsePoint;}
 if(reparsePoint)rejectPrivate('reparse');
 if(!windowsAllowAces(aces,currentSid))rejectPrivate('acl');
 return true;
}
function snapshotHostFile(hostFile,options={}){
 if(typeof hostFile!=='string'||!path.isAbsolute(hostFile))rejectPrivate('path');
 let fd;try{fd=fs.openSync(hostFile,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW);}catch{rejectPrivate('open');}
 try{
  const stat=fs.fstatSync(fd);
  if(!stat.isFile())rejectPrivate('type');
  if(stat.nlink!==1)rejectPrivate('link');
  if(stat.size<=0||stat.size>maxBytes)rejectPrivate('size');
  if((stat.mode&0o777)!==privateMode&&!windowsPrivateFileAccepted(hostFile,stat,options))rejectPrivate('mode');
  const raw=readExact(fd,stat.size);
  let parsed;try{parsed=JSON.parse(raw.toString('utf8'));}catch{fail('CONTROLLED_REAL_PRIVATE_INPUT_INVALID');}
  return {fd,raw,accepted:validatePilotPrivateInput(parsed)};
 }catch(error){fs.closeSync(fd);throw error;}
}
export function readHostPilotPrivateFile(hostFile,options){
 const opened=snapshotHostFile(hostFile,options);
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
function invoke(execFileSync,command,args,input){
 const stdio=[input===undefined?'ignore':'pipe','pipe','pipe'];
 try{return execFileSync(command,args,{encoding:'utf8',timeout:20000,env:{PATH:process.env.PATH??''},stdio,...(input===undefined?{}:{input})});}
 catch{fail('PILOT_PRIVATE_CONTAINER_UNVERIFIED');}
}
export function containerPrivateInstallPlan({docker,container,containerTemp,destination}={}){
 if(docker!=='docker'&&(typeof docker!=='string'||!path.isAbsolute(docker)))fail('PILOT_PRIVATE_CONTAINER_UNVERIFIED');
 if(!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/.test(container??'')||destination!==PILOT_PRIVATE_CONFIG_PATH)fail('PILOT_PRIVATE_CONTAINER_UNVERIFIED');
 if(!/^\/tmp\/qiwe-private-[a-f0-9]{16}$/.test(containerTemp??''))fail('PILOT_PRIVATE_CONTAINER_UNVERIFIED');
 return [[docker,'exec','-i','--user','1000:1000',container,'sh','-c',`umask 077; cat > ${containerTemp}`],[docker,'exec','--user','1000:1000',container,'sha256sum',containerTemp],[docker,'exec','--user','1000:1000',container,'stat','-c','%u %g %a %h %s',containerTemp]];
}
function linkContainerFile(execFileSync,docker,container,containerTemp,destination){
 const options={encoding:'utf8',timeout:20000,env:{PATH:process.env.PATH??''},stdio:['ignore','pipe','pipe']};
 try{execFileSync(docker,['exec','--user','1000:1000',container,'ln','-T',containerTemp,destination],options);}
 catch(error){
  const detail=`${error?.stderr??''}\n${error?.message??''}`;
  if(/directory/i.test(detail))fail('PILOT_PRIVATE_DESTINATION_DIRECTORY');
  if(error?.status===1&&/file exists/i.test(detail))fail('PILOT_PRIVATE_DESTINATION_INVALID');
  fail('PILOT_PRIVATE_CONTAINER_UNVERIFIED');
 }
}
export function runContainerPrivateInstall(options){
 const opened=snapshotHostFile(options?.hostFile,options);
 let snapshot;
 try{
  if(!reread(opened.fd,opened.raw))fail('PILOT_PRIVATE_INPUT_CHANGED');
  snapshot=writeSnapshotCopy(opened.raw);
  const containerTemp=`/tmp/qiwe-private-${randomBytes(8).toString('hex')}`;
  const commands=containerPrivateInstallPlan({docker:options?.docker,container:options?.container,containerTemp,destination:options?.destination});
  const execFileSync=options?.execFileSync;if(typeof execFileSync!=='function')fail('PILOT_PRIVATE_CONTAINER_UNVERIFIED');
  const hash=createHash('sha256').update(opened.raw).digest('hex');
  let copied=false;
  try{
   let statText='',hashText='';
   for(const [command,...args] of commands){
    const output=invoke(execFileSync,command,args,args.some(item=>String(item).includes('cat >'))?opened.raw:undefined);
    if(args.some(item=>String(item).includes('cat >')))copied=true;
    if(args.includes('sha256sum'))hashText=String(output??'');
    if(args.includes('stat'))statText=String(output??'');
   }
   const hashed=/^([a-f0-9]{64})(?:\s|$)/.exec(hashText),measured=/^1000 1000 600 1 (\d+)\n?$/.exec(statText);
   if(!hashed||hashed[1]!==hash||!measured||Number(measured[1])!==opened.raw.length)fail('PILOT_PRIVATE_CONTAINER_UNVERIFIED');
   const again=snapshotHostFile(options.hostFile,options);
   try{if(!again.raw.equals(opened.raw))fail('PILOT_PRIVATE_INPUT_CHANGED');}
   finally{fs.closeSync(again.fd);}
   linkContainerFile(execFileSync,commands[0][0],options.container,containerTemp,options.destination);
   invoke(execFileSync,commands[0][0],['exec','--user','1000:1000',options.container,'rm','-f',containerTemp]);
   const rootStat=String(invoke(execFileSync,commands[0][0],['exec','--user','0:0',options.container,'stat','-c','%u %g %a %h %s',options.destination])??'');
   if(!/^1000 1000 600 \d+ \d+\n?$/.test(rootStat))fail('PILOT_PRIVATE_CONTAINER_UNVERIFIED');
   const finalStat=String(invoke(execFileSync,commands[0][0],['exec','--user','1000:1000',options.container,'stat','-c','%u %g %a %h %s',options.destination])??'');
   const finalHash=String(invoke(execFileSync,commands[0][0],['exec','--user','1000:1000',options.container,'sha256sum',options.destination])??'');
   const published=/^1000 1000 600 (\d+) (\d+)\n?$/.exec(finalStat),sum=/^([a-f0-9]{64})(?:\s|$)/.exec(finalHash);
   if(!published||Number(published[1])!==1||Number(published[2])!==opened.raw.length||!sum||sum[1]!==hash)fail('PILOT_PRIVATE_CONTAINER_UNVERIFIED');
   return freeze({uid:containerUser,gid:containerUser,mode:privateMode,nlink:Number(published[1]),bytes:Number(published[2])});
  }catch(error){
   if(copied)invoke(execFileSync,commands[0][0],['exec','--user','1000:1000',options.container,'rm','-f',containerTemp]);
   throw error;
  }
 }finally{fs.closeSync(opened.fd);if(snapshot)fs.rmSync(snapshot.dir,{recursive:true,force:true});}
}
