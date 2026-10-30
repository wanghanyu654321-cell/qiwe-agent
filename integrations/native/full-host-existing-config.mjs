import fs from 'node:fs';

// Reuse the original scanner's directory descriptor and exact prior lstat.
// Return a non-sensitive reason only; neither configuration bytes nor secret
// digests leave this function. The scanner remains responsible for budgeting,
// its second lstat and binding the returned reason and stat to its ticket.
export function inspectExistingConfig(parentFd,relative,stat,{webSessionSecret,pluginAutoScan}={}) {
 if(process.platform!=='linux'||process.getuid?.()!==1000||process.getgid?.()!==1000||
   !Number.isSafeInteger(parentFd)||parentFd<0||!['config/session-secret.key','config/system-settings.json'].includes(relative))return undefined;
 const stamp=s=>[s.dev,s.ino,s.mode,s.nlink,s.size,s.mtimeNs,s.ctimeNs].map(String).join(':');
 if(!stat?.isFile?.()||stat.uid!==1000n||stat.gid!==1000n||stat.nlink!==1n||
   stat.size<=0n||stat.size>131072n||(stat.mode&0o022n)!==0n||
   relative==='config/session-secret.key'&&(stat.mode&0o077n)!==0n)return undefined;
 let fd;
 try{
  if(!fs.fstatSync(parentFd).isDirectory())return undefined;
  const name='/proc/self/fd/'+parentFd+'/'+relative.slice('config/'.length);
  fd=fs.openSync(name,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW);
  if(stamp(fs.fstatSync(fd,{bigint:true}))!==stamp(stat))return undefined;
  const bytes=fs.readFileSync(fd);
  if(bytes.length!==Number(stat.size)||stamp(fs.fstatSync(fd,{bigint:true}))!==stamp(stat)||stamp(fs.lstatSync(name,{bigint:true}))!==stamp(stat))return undefined;
  // Match fs.readFileSync(..., 'utf8') + JSON.parse, which does not silently
  // discard a BOM from a settings file.
  const text=new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(bytes);
  if(relative==='config/session-secret.key')return typeof webSessionSecret==='string'&&webSessionSecret.length>0&&text.trim()===webSessionSecret?'original_loaded_session_secret':undefined;
  const value=JSON.parse(text);
  if(!value||typeof value!=='object'||Array.isArray(value)||value.pluginAutoScan!==false||pluginAutoScan!==false)return undefined;
  // JSON.parse accepts duplicate keys; inspect the original token stream to
  // reject all duplicate top-level spellings, including escaped property names.
  let depth=0,count=0;
  for(let i=0;i<text.length;i++){
   const ch=text[i];if(ch==='{'||ch==='['){depth++;continue;}if(ch==='}'||ch===']'){depth--;continue;}
   if(ch!=='"')continue;const start=i++;for(;i<text.length;i++){if(text[i]==='\\'){i++;continue;}if(text[i]==='"')break;}
   if(depth!==1||JSON.parse(text.slice(start,i+1))!=='pluginAutoScan')continue;
   let next=i+1;while(next<text.length&&/\s/.test(text[next]))next++;
   if(text[next]!==':')continue;next++;while(next<text.length&&/\s/.test(text[next]))next++;
   if(!text.startsWith('false',next))return undefined;count++;
  }
  return count===1?'original_disabled_plugin_autoscan':undefined;
 }catch{return undefined;}finally{if(fd!==undefined)fs.closeSync(fd);}
}
