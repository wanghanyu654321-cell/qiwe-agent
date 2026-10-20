import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';
import {gunzipSync} from 'node:zlib';

const version='12.11.1',abi='137';
const npmUrl=`https://registry.npmjs.org/better-sqlite3/-/better-sqlite3-${version}.tgz`;
const npmIntegrity='sha512-dq9AtApgg5PGFtBzPFSBl3HZQjHok5gaQCM6zh2Yk0aSmDCs1CbnVI8/HgASQkNKsWFpseIO9beg5xxpYhbIfA==';
const assetName=`better-sqlite3-v${version}-node-v${abi}-win32-x64.tar.gz`;
const assetUrl=`https://github.com/WiseLibs/better-sqlite3/releases/download/v${version}/${assetName}`;
// GitHub release API asset digest, retrieved 2026-10-20. This is a published
// transport/content check, not an assertion that the asset has a signature.
const assetSha256='4ee5e653174d6ddd301605d351798cdae2613da06c4f37ecdce263021fcf1255';
const binarySha256='e75b8c024a85179d8e0e51203a8b8867916e9a51327ce3953db5f8483cc9a91e';
const hash=(bytes,algorithm='sha256',encoding='hex')=>createHash(algorithm).update(bytes).digest(encoding);
const unsafe=()=>{throw Error('Unsafe archive');};

export function verifyPreparedNativeSqlite(source,prepared) {
  if(!source||!prepared||!path.isAbsolute(source)||!path.isAbsolute(prepared))throw Error('Native source and prepared package must be absolute');
  source=fs.realpathSync(source);prepared=fs.realpathSync(prepared);
  const app=path.dirname(source),original=path.join(app,'node_modules/better-sqlite3');
  const lock=JSON.parse(fs.readFileSync(path.join(app,'package-lock.json'),'utf8')).packages?.['node_modules/better-sqlite3'];
  if(lock?.version!==version||lock?.resolved!==npmUrl||lock?.integrity!==npmIntegrity)throw Error('Native lock differs from pinned better-sqlite3 release');
  const originalMetadata=fs.readFileSync(path.join(original,'package.json')),preparedMetadata=fs.readFileSync(path.join(prepared,'package.json'));
  const metadata=JSON.parse(originalMetadata.toString());
  if(metadata.name!=='better-sqlite3'||metadata.version!==version||!originalMetadata.equals(preparedMetadata))throw Error('Prepared package metadata differs from original driver');
  const files=(directory,prefix='')=>fs.readdirSync(directory,{withFileTypes:true}).flatMap(entry=>{
    const relative=prefix+entry.name;
    if(entry.isSymbolicLink())throw Error('Prepared/source lib contains a symlink');
    if(entry.isDirectory())return files(path.join(directory,entry.name),relative+'/');
    if(!entry.isFile())throw Error('Prepared/source lib has a non-file entry');
    return [relative];
  }).sort();
  const originals=files(path.join(original,'lib')),preparedFiles=files(path.join(prepared,'lib'));
  if(JSON.stringify(originals)!==JSON.stringify(preparedFiles)||!originals.includes('index.js'))throw Error('Prepared JS differs from original driver');
  for(const relative of originals)if(!fs.readFileSync(path.join(original,'lib',relative)).equals(fs.readFileSync(path.join(prepared,'lib',relative))))throw Error(`Prepared JS differs from original driver: ${relative}`);
  if(hash(fs.readFileSync(path.join(prepared,'build/Release/better_sqlite3.node')))!==binarySha256)throw Error('Prepared binary differs from pinned official release member');
  // Resolving a package is read-only and does not evaluate its JS. A substituted
  // loader dependency must not be able to execute before the binary admission.
  const require=createRequire(path.join(prepared,'package.json'));
  for(const [name,main,wanted] of [['bindings','bindings.js','1.5.0'],['file-uri-to-path','index.js','1.0.0']]){
    const allowed=path.join(app,'node_modules',name);
    if(fs.realpathSync(require.resolve(name))!==fs.realpathSync(path.join(allowed,main))||JSON.parse(fs.readFileSync(path.join(allowed,'package.json'),'utf8')).version!==wanted)throw Error(`Prepared dependency differs from original loader: ${name}`);
  }
  if(process.platform!=='win32'||process.arch!=='x64'||process.versions.modules!==abi)throw Error('This pinned fixture requires Windows x64 Node ABI 137; no rebuild or fallback is allowed');
  return {packagePath:prepared,version,platform:process.platform,arch:process.arch,abi,binarySha256};
}

export function readArchive(buffer) {
  const tar=gunzipSync(buffer,{maxOutputLength:32*1024*1024});
  if(tar.length%512!==0)unsafe();
  const files=[],seen=new Set();let offset=0,ended=false;
  const string=(h,start,length)=>h.subarray(start,start+length).toString('utf8').split('\0')[0];
  const octal=(value)=>{if(!/^[0-7]+$/.test(value.trim()))unsafe();return Number.parseInt(value.trim(),8);};
  while(offset<tar.length){
    const h=tar.subarray(offset,offset+512);offset+=512;
    if(h.every(byte=>byte===0)){if(!tar.subarray(offset).every(byte=>byte===0))unsafe();ended=true;break;}
    const checksum=octal(string(h,148,8));
    if(h.reduce((sum,byte,index)=>sum+(index>=148&&index<156?32:byte),0)!==checksum)unsafe();
    const prefix=string(h,345,155),name=(prefix?prefix+'/':'')+string(h,0,100),type=string(h,156,1)||'0';
    if(!name||/[\\:\x00-\x1f]/.test(name)||name.startsWith('/')||name.includes('//')||name.split('/').some(p=>p==='..'||p==='.')||seen.has(name))unsafe();
    seen.add(name);
    const size=octal(string(h,124,12));
    if(!Number.isSafeInteger(size)||size<0||offset+size>tar.length||!['0','5'].includes(type)||(type==='5'&&size!==0))unsafe();
    if(type==='0')files.push({name,data:Buffer.from(tar.subarray(offset,offset+size))});
    offset+=Math.ceil(size/512)*512;
  }
  if(!ended)unsafe();
  return files;
}

async function download(url){
  let current=new URL(url);
  for(let redirects=0;redirects<=4;redirects++){
    if(current.protocol!=='https:'||current.username||current.password||!['registry.npmjs.org','github.com','release-assets.githubusercontent.com'].includes(current.hostname))throw Error('Untrusted download host');
    const response=await fetch(current,{redirect:'manual',credentials:'omit',signal:AbortSignal.timeout(30000)});
    if([301,302,303,307,308].includes(response.status)){
      const location=response.headers.get('location');if(!location)throw Error('Missing redirect location');
      current=new URL(location,current);continue;
    }
    if(!response.ok)throw Error(`Official package download failed: HTTP ${response.status}`);
    const limit=16*1024*1024;
    if(Number(response.headers.get('content-length'))>limit)throw Error('Official archive exceeds size limit');
    const reader=response.body.getReader(),chunks=[];let size=0;
    for(;;){const {value,done}=await reader.read();if(done)break;size+=value.length;if(size>limit){await reader.cancel();throw Error('Official archive exceeds size limit');}chunks.push(value);}
    return Buffer.concat(chunks);
  }
  throw Error('Too many download redirects');
}

export async function prepareNativeSqlite(source){
  if(process.platform!=='win32'||process.arch!=='x64'||process.versions.modules!==abi)throw Error('This pinned fixture requires Windows x64 Node ABI 137; no rebuild or fallback is allowed');
  if(!source||!path.isAbsolute(source))throw Error('An absolute Native src directory is required');
  source=fs.realpathSync(source);
  const app=path.dirname(source),originalPackage=path.join(app,'node_modules/better-sqlite3');
  const lock=JSON.parse(fs.readFileSync(path.join(app,'package-lock.json'),'utf8')).packages?.['node_modules/better-sqlite3'];
  const original=JSON.parse(fs.readFileSync(path.join(originalPackage,'package.json'),'utf8'));
  if(lock?.version!==version||lock?.resolved!==npmUrl||lock?.integrity!==npmIntegrity||original.version!==version)throw Error('Native lock/installed package differs from pinned better-sqlite3 release');
  const [npmBytes,assetBytes]=await Promise.all([download(npmUrl),download(assetUrl)]);
  if('sha512-'+hash(npmBytes,'sha512','base64')!==npmIntegrity||hash(assetBytes)!==assetSha256)throw Error('Official archive integrity mismatch');
  const packageEntries=readArchive(npmBytes),binaryEntries=readArchive(assetBytes);
  if(binaryEntries.length!==1||binaryEntries[0].name!=='build/Release/better_sqlite3.node')throw Error('Unexpected release archive members');
  const binary=binaryEntries[0].data;
  if(binary.length<64||binary.toString('ascii',0,2)!=='MZ')throw Error('Release binary is not a Windows PE');
  const pe=binary.readUInt32LE(60);
  if(pe+6>binary.length||binary.toString('ascii',pe,pe+4)!=='PE\0\0'||binary.readUInt16LE(pe+4)!==0x8664)throw Error('Release binary is not Windows x64');
  const entries=packageEntries.filter(entry=>entry.name==='package/package.json'||/^package\/lib\/.+\.js$/.test(entry.name)||entry.name==='package/LICENSE');
  const packageJson=JSON.parse(entries.find(entry=>entry.name==='package/package.json')?.data.toString()??'null');
  if(packageJson?.name!=='better-sqlite3'||packageJson.version!==version||!entries.some(entry=>entry.name==='package/lib/index.js'))throw Error('Unexpected official npm package');
  const originalJs={};
  for(const entry of entries.filter(entry=>entry.name.endsWith('.js'))){
    const relative=entry.name.slice('package/'.length),originalBytes=fs.readFileSync(path.join(originalPackage,relative));
    if(!originalBytes.equals(entry.data))throw Error(`Original JS differs from integrity-checked npm release: ${relative}`);
    originalJs[relative]=hash(originalBytes);
  }
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'qiwe-native-sqlite-'));
  try{
    const prepared=path.join(directory,'better-sqlite3');fs.mkdirSync(prepared);
    for(const entry of entries){const target=path.join(prepared,entry.name.slice('package/'.length));fs.mkdirSync(path.dirname(target),{recursive:true});fs.writeFileSync(target,entry.data,{flag:'wx'});}
    const target=path.join(prepared,'build/Release/better_sqlite3.node');fs.mkdirSync(path.dirname(target),{recursive:true});fs.writeFileSync(target,binary,{flag:'wx'});
    fs.mkdirSync(path.join(prepared,'node_modules'));
    const dependencies={};
    for(const [name,wanted] of Object.entries({'bindings':'1.5.0','file-uri-to-path':'1.0.0'})){
      const location=path.join(app,'node_modules',name),metadata=JSON.parse(fs.readFileSync(path.join(location,'package.json'),'utf8'));
      if(metadata.version!==wanted)throw Error(`Unexpected original dependency version: ${name}`);
      fs.symlinkSync(location,path.join(prepared,'node_modules',name),'junction');dependencies[name]=wanted;
    }
    verifyPreparedNativeSqlite(source,prepared);
    // Only the published driver and its small JS loader dependencies execute.
    // No source config, database, application entry point, or lifecycle script.
    const Database=createRequire(path.join(prepared,'package.json'))(prepared);
    const db=new Database(':memory:');try{if(db.prepare('SELECT 1 AS loaded').get().loaded!==1)throw Error('Native driver probe failed');}finally{db.close();}
    const manifest={version,platform:process.platform,arch:process.arch,abi,node:process.version,packagePath:prepared,npmUrl,npmIntegrity,assetUrl,assetSha256,binarySha256:hash(binary),originalJs,dependencies,originalSqliteCompatSha256:hash(fs.readFileSync(path.join(source,'sqlite-compat.ts')))};
    fs.writeFileSync(path.join(directory,'manifest.json'),JSON.stringify(manifest,null,2)+'\n',{flag:'wx'});
    return manifest;
  }catch(error){
    const resolved=fs.realpathSync(directory);
    if(path.dirname(resolved)!==fs.realpathSync(os.tmpdir())||!path.basename(resolved).startsWith('qiwe-native-sqlite-'))throw Error('Unsafe temp cleanup');
    fs.rmSync(resolved,{recursive:true,force:true});throw error;
  }
}

if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  const args=process.argv.slice(2);
  if(args.length!==2||args[1]!=='--download')throw Error('Usage: node integrations/native/prepare-native-sqlite.mjs ABSOLUTE_NATIVE_SRC --download');
  console.log(JSON.stringify(await prepareNativeSqlite(args[0]),null,2));
}
