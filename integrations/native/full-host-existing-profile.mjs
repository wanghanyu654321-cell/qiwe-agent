import fs from 'node:fs';
import path from 'node:path';

const segment=value=>typeof value==='string'&&/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(value);
const stamp=stat=>[stat.dev,stat.ino,stat.mode,stat.nlink,stat.mtimeNs,stat.ctimeNs].map(String).join(':');

/** Current local snapshot only. Absence of extra context is not authorization,
 * skill availability or proof that a future configuration remains unchanged.
 * The original scanner must rescan this fact when claiming its restore ticket.
 */
export function inspectExistingProfileContext(dataDir,ownerId,groups,allowStep=()=>true){
 if(process.platform!=='linux'||typeof dataDir!=='string'||dataDir==='/'||!path.isAbsolute(dataDir)||path.normalize(dataDir)!==dataDir||dataDir.includes('\0')||
   !segment(ownerId)||!Array.isArray(groups)||groups.length===0||groups.length>100000||!groups.every(segment)||typeof allowStep!=='function')return false;
 const flags=fs.constants.O_RDONLY|fs.constants.O_DIRECTORY|fs.constants.O_NOFOLLOW;
 const opened=[],directories=new Map(),missing=[];
 const deadline=performance.now()+5000;let operations=0;
 const probe=(method,...args)=>{if(++operations>100000||performance.now()>deadline||!allowStep())throw Error('profile_context_budget');return fs[method](...args);};
 const descriptor=fd=>'/proc/self/fd/'+fd;
 function remember(logical,fd,expected){
  let current;try{current=probe('fstatSync',fd,{bigint:true});if(!current.isDirectory()||expected&&stamp(current)!==stamp(expected))throw Error('profile_context_directory_changed');}catch(error){fs.closeSync(fd);throw error;}
  const entry={fd,version:stamp(current)};opened.push(entry);directories.set(logical,entry);return fd;
 }
 function child(parent,logical,name){
  const known=directories.get(logical);if(known)return known.fd;
  const target=descriptor(parent)+'/'+name,stat=probe('lstatSync',target,{bigint:true});
  if(!stat.isDirectory()||stat.isSymbolicLink())throw Error('profile_context_unsafe_directory');
  return remember(logical,probe('openSync',target,flags),stat);
 }
 try{
  let current=remember('/',probe('openSync','/',flags)),logical='';
  for(const name of dataDir.slice(1).split('/')){logical+='/'+name;current=child(current,logical,name);}
  const data=current;
  function absent(parts){
   let parent=data,logical=dataDir;
   for(let i=0;i<parts.length;i++){
    const name=parts[i],target=descriptor(parent)+'/'+name;let stat;
    try{stat=probe('lstatSync',target,{bigint:true});}catch(error){if(error.code!=='ENOENT')throw error;missing.push({parent,name});return true;}
    if(i===parts.length-1)return false;
    if(!stat.isDirectory()||stat.isSymbolicLink())return false;
    logical+='/'+name;parent=child(parent,logical,name);
   }
   return false;
  }
  // The local proof excludes every managed MCP definition/secret, including
  // system and legacy entries, rather than interpreting an unverified store.
  if(!absent(['mcp-servers'])||!absent(['plugins','users',ownerId,'plugins.json']))return false;
  for(const folder of new Set(groups))for(const suffix of [['.mcp.json'],['.claude','settings.json'],['.claude','settings.local.json']])
   if(!absent(['groups',folder,...suffix]))return false;
  for(const item of missing){try{probe('lstatSync',descriptor(item.parent)+'/'+item.name,{bigint:true});return false;}catch(error){if(error.code!=='ENOENT')throw error;}}
  return opened.every(entry=>stamp(probe('fstatSync',entry.fd,{bigint:true}))===entry.version);
 }catch{return false;}finally{for(const entry of opened.reverse())fs.closeSync(entry.fd);}
}
