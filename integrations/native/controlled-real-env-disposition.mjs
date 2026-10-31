import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';

const witnesses=new WeakSet();
const fixedTexts=[
 Buffer.from("MINICLAW_CLAUDE_ENDPOINT_KIND='official'\n"),
 Buffer.from("MINICLAW_CLAUDE_ENDPOINT_KIND='official'\nMINICLAW_AGENT_MCP_POLICY='disabled'\n"),
];
const folderOk=value=>typeof value==='string'&&/^[a-z0-9][a-z0-9_-]{0,127}$/.test(value);
const namesOf=folder=>['env',folder,'default','main','env'];
const stamp=stat=>({dev:String(stat.dev),ino:String(stat.ino)});
const fail=code=>{throw Error(code);};
function freeze(value){
 if(value&&typeof value==='object'&&!Object.isFrozen(value)){for(const item of Object.values(value))freeze(item);Object.freeze(value);}
 return value;
}
function walk(dataDir,folder){
 const names=namesOf(folder);let current=dataDir;const chain=[];
 for(let index=0;index<names.length;index++){
  current=path.join(current,names[index]);
  let stat;try{stat=fs.lstatSync(current,{bigint:true});}catch(error){if(error?.code==='ENOENT')return {absentAt:index,chain,file:current};throw error;}
  if(stat.isSymbolicLink())fail('PILOT_ENV_PATH_UNSAFE');
  const kind=stat.isDirectory()?'dir':stat.isFile()?'file':'other';
  chain.push({name:names[index],...stamp(stat),kind,nlink:String(stat.nlink),size:String(stat.size)});
 }
 return {absentAt:-1,chain,file:current};
}
/** Record that the exact runner env file is absent. The returned object cannot
 * be forged or cloned into a deletion permit. */
export function witnessPilotEnvAbsence(dataDir,folder){
 if(typeof dataDir!=='string'||!path.isAbsolute(dataDir)||!folderOk(folder))fail('PILOT_ENV_WITNESS_INVALID');
 const root=fs.lstatSync(dataDir,{bigint:true});
 if(root.isSymbolicLink()||!root.isDirectory())fail('PILOT_ENV_WITNESS_INVALID');
 const seen=walk(dataDir,folder);
 if(seen.absentAt===-1){
  const file=seen.chain.at(-1);
  if(file.kind!=='file'||file.nlink!=='1')fail('PILOT_ENV_PATH_UNSAFE');
  const opened=readRegular(seen.file);
  if(!same(stamp(opened.stat),file))fail('PILOT_ENV_WITNESS_INVALID');
  const witness=freeze({status:'preexisting',dataDir,folder,root:stamp(root),chain:seen.chain.slice(0,-1),file:{...file,contentSha256:opened.sha256}});
  witnesses.add(witness);return witness;
 }
 const witness=freeze({status:'absent',dataDir,folder,root:stamp(root),absentAt:seen.absentAt,chain:seen.chain});
 witnesses.add(witness);return witness;
}
function same(left,right){return !!left&&!!right&&left.dev===right.dev&&left.ino===right.ino;}
function readRegular(file){
 const fd=fs.openSync(file,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW);
 try{
  const stat=fs.fstatSync(fd,{bigint:true});
  if(!stat.isFile()||stat.nlink!==1n||stat.size>131072n)fail('PILOT_ENV_PATH_UNSAFE');
  const raw=Buffer.alloc(Number(stat.size));
  let offset=0;while(offset<raw.length){const count=fs.readSync(fd,raw,offset,raw.length-offset,offset);if(count===0)break;offset+=count;}
  if(offset!==raw.length)fail('PILOT_ENV_DISPOSE_UNCONFIRMED');
  const again=fs.fstatSync(fd,{bigint:true});
  if(!same(stamp(again),stamp(stat))||again.size!==stat.size)fail('PILOT_ENV_DISPOSE_UNCONFIRMED');
  return {stat,raw,sha256:createHash('sha256').update(raw).digest('hex')};
 }finally{fs.closeSync(fd);}
}
function unlinkVerified(file,identity){
 const parent=path.dirname(file);
 const parentFd=fs.openSync(parent,fs.constants.O_RDONLY|fs.constants.O_DIRECTORY|fs.constants.O_NOFOLLOW);
 let fileFd;
 try{
  fileFd=fs.openSync(file,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW);
  const stat=fs.fstatSync(fileFd,{bigint:true});
  if(!stat.isFile()||stat.nlink!==1n||!same(stamp(stat),identity))fail('PILOT_ENV_DISPOSE_UNCONFIRMED');
  const raw=Buffer.alloc(Number(stat.size));
  let offset=0;while(offset<raw.length){const count=fs.readSync(fileFd,raw,offset,raw.length-offset,offset);if(count===0)break;offset+=count;}
  const reread=Buffer.alloc(raw.length);fs.readSync(fileFd,reread,0,reread.length,0);
  if(offset!==raw.length||!reread.equals(raw))fail('PILOT_ENV_DISPOSE_UNCONFIRMED');
  fs.unlinkSync(file);
  if(fs.fstatSync(fileFd,{bigint:true}).nlink!==0n)fail('PILOT_ENV_DISPOSE_UNKNOWN');
  try{fs.lstatSync(file);fail('PILOT_ENV_DISPOSE_UNKNOWN');}catch(error){if(error?.code!=='ENOENT')fail('PILOT_ENV_DISPOSE_UNKNOWN');}
  fs.fsyncSync(parentFd);
 }finally{if(fileFd!==undefined)fs.closeSync(fileFd);fs.closeSync(parentFd);}
}
function confirmed(executor){
 if(!executor||Object.keys(executor).sort().join(',')!=='exitCode,signal,state'||executor.state!=='exited')return false;
 const code=executor.exitCode===null||Number.isInteger(executor.exitCode);
 const signal=executor.signal===null||typeof executor.signal==='string'&&executor.signal.length>0&&executor.signal.length<=32;
 return code&&signal&&!(executor.exitCode===null&&executor.signal===null);
}
/** After the owned executor's close event, unlink only the one new env file.
 * Original files, sibling names, and unknown executor results stay untouched. */
export function disposeConfirmedNewPilotEnv(dataDir,folder,witness,executor){
 if(!witnesses.has(witness)||witness.dataDir!==dataDir||witness.folder!==folder||!confirmed(executor))fail('PILOT_ENV_DISPOSE_UNCONFIRMED');
 const root=fs.lstatSync(dataDir,{bigint:true});
 if(root.isSymbolicLink()||!root.isDirectory()||!same(stamp(root),witness.root))fail('PILOT_ENV_DISPOSE_UNCONFIRMED');
 if(witness.status==='preexisting'){
  const target=path.join(dataDir,'env',folder,'default','main','env');
  let listed;try{listed=fs.lstatSync(target,{bigint:true});}catch(error){if(error?.code==='ENOENT')fail('PILOT_ENV_DISPOSE_UNCONFIRMED');throw error;}
  if(listed.isSymbolicLink()||!listed.isFile()||listed.nlink!==1n)fail('PILOT_ENV_PATH_UNSAFE');
  const opened=readRegular(target);
  if(same(stamp(opened.stat),witness.file)&&opened.sha256===witness.file.contentSha256)return freeze({disposed:false,reason:'original_file_retained',extraEntries:0});
  if(same(stamp(opened.stat),witness.file))fail('PILOT_ENV_DISPOSE_UNCONFIRMED');
  unlinkVerified(target,stamp(opened.stat));
  return freeze({disposed:true,reason:'crash_residue_removed',extraEntries:0});
 }
 const seen=walk(dataDir,folder);
 if(seen.chain.length<witness.chain.length||!witness.chain.every((item,index)=>same(item,seen.chain[index])&&item.name===seen.chain[index].name))fail('PILOT_ENV_DISPOSE_UNCONFIRMED');
 if(seen.absentAt!==-1)return freeze({disposed:false,reason:'still_absent',extraEntries:0});
 const created=seen.chain.slice(witness.chain.length),expected=namesOf(folder).slice(witness.absentAt);
 if(created.length!==expected.length||created.some((item,index)=>item.name!==expected[index]||(index<created.length-1?item.kind!=='dir':item.kind!=='file'||item.nlink!=='1')))fail('PILOT_ENV_PATH_UNSAFE');
 const parent=path.dirname(seen.file),parentStamp=created.length>1?created.at(-2):witness.chain.at(-1);
 if(!parentStamp||!same(parentStamp,stamp(fs.lstatSync(parent,{bigint:true}))))fail('PILOT_ENV_DISPOSE_UNCONFIRMED');
 const directoryFlags=fs.constants.O_RDONLY|fs.constants.O_DIRECTORY|fs.constants.O_NOFOLLOW;
 const parentFd=fs.openSync(parent,directoryFlags);let fileFd;
 try{
  if(!same(stamp(fs.fstatSync(parentFd,{bigint:true})),parentStamp))fail('PILOT_ENV_DISPOSE_UNCONFIRMED');
  fileFd=fs.openSync(seen.file,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW);
  const stat=fs.fstatSync(fileFd,{bigint:true});
  if(!stat.isFile()||stat.nlink!==1n||!same(stamp(stat),created.at(-1))||stat.size>131072n)fail('PILOT_ENV_PATH_UNSAFE');
  const raw=fs.readFileSync(fileFd);
  if(raw.length!==Number(stat.size)||!same(stamp(fs.fstatSync(fileFd,{bigint:true})),created.at(-1)))fail('PILOT_ENV_DISPOSE_UNCONFIRMED');
  const names=fs.readdirSync(parent);
  if(!names.includes('env'))fail('PILOT_ENV_DISPOSE_UNCONFIRMED');
  const extraEntries=names.filter(name=>name!=='env').length;
  if(fixedTexts.some(text=>text.equals(raw)))return freeze({disposed:false,reason:'fixed_secret_free_retained',extraEntries});
  const reread=Buffer.alloc(raw.length);fs.readSync(fileFd,reread,0,reread.length,0);
  if(!same(stamp(fs.fstatSync(parentFd,{bigint:true})),parentStamp)||!same(stamp(fs.fstatSync(fileFd,{bigint:true})),created.at(-1))||!reread.equals(raw))fail('PILOT_ENV_DISPOSE_UNCONFIRMED');
  fs.unlinkSync(seen.file);
  if(fs.fstatSync(fileFd,{bigint:true}).nlink!==0n)fail('PILOT_ENV_DISPOSE_UNKNOWN');
  try{fs.lstatSync(seen.file);fail('PILOT_ENV_DISPOSE_UNKNOWN');}catch(error){if(error?.code!=='ENOENT')fail('PILOT_ENV_DISPOSE_UNKNOWN');}
  fs.fsyncSync(parentFd);
  return freeze({disposed:true,reason:'new_run_file_removed',extraEntries});
 }finally{if(fileFd!==undefined)fs.closeSync(fileFd);fs.closeSync(parentFd);}
}
