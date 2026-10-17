import type {ManagerStore,StaffContext} from './manager-store.js';
import type {BotReadScope} from './wecom-bot-context.js';
import fs from 'node:fs';
import path from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {isDeepStrictEqual} from 'node:util';
import AdmZip from 'adm-zip';
import {validDate} from './manager-report.js';
import {salesWorkbookParts} from './unified-workbook.js';
export type ManagerSnapshot=ReturnType<ManagerStore['summary']>;
export interface ArtifactOwner {accountId:string;actor:StaffContext;}
export interface ManagerArtifact {snapshotHash:string;sha256:string;filename:string;byteLength:number;}
const digest=(value:string|Uint8Array)=>createHash('sha256').update(value).digest('hex');
const hash=(value:unknown):value is string=>typeof value==='string'&&/^[a-f0-9]{64}$/.test(value);
const label=(value:unknown):value is string=>typeof value==='string'&&!!value.trim()&&value.length<=200&&!/[\u0000-\u001f]/.test(value);
const cents=(value:unknown)=>value===null||Number.isSafeInteger(value)&&Number(value)>=0;
const rate=(value:unknown)=>value===null||typeof value==='number'&&Number.isFinite(value)&&value>=0;
const keys=(value:unknown,allowed:string[])=>value!==null&&typeof value==='object'&&!Array.isArray(value)&&Object.keys(value).every(key=>allowed.includes(key));
function identity(raw:ArtifactOwner):{owner:ArtifactOwner;key:string}{
 let owner:ArtifactOwner;try{owner=structuredClone(raw);}catch{throw Error('invalid_artifact_owner');}
 if(!owner?.actor||![owner.accountId,owner.actor.tenant,owner.actor.store,owner.actor.workspace,owner.actor.employeeId,owner.actor.employeeName].every(label))throw Error('invalid_artifact_owner');
 return {owner,key:digest(JSON.stringify([owner.actor.tenant,owner.actor.store,owner.actor.workspace,owner.accountId,owner.actor.employeeId]))};
}
function snapshotCopy(raw:ManagerSnapshot,owner:ArtifactOwner):ManagerSnapshot{
 let s:ManagerSnapshot;try{s=structuredClone(raw);}catch{throw Error('invalid_artifact_snapshot');}
 const invalid=()=>{throw Error('invalid_artifact_snapshot');};
 if(!s||s.metric!=='sales-turnover/v1'||!s.scope||s.scope.tenant!==owner.actor.tenant||s.scope.store!==owner.actor.store||s.scope.workspace!==owner.actor.workspace||!s.period||!validDate(s.period.start)||!validDate(s.period.end)||s.period.start>s.period.end||!['half','month','four','year'].includes(s.kind)||!hash(s.snapshotHash)||typeof s.observedAt!=='string'||!Number.isFinite(Date.parse(s.observedAt))||!Array.isArray(s.entries)||!Array.isArray(s.rows)||!Array.isArray(s.incompatible)||!cents(s.salesCents)||!cents(s.targetCents)||!rate(s.rate)||!(s.varianceCents===null||Number.isSafeInteger(s.varianceCents))||!['complete','partial'].includes(s.coverage))invalid();
 for(const row of s.rows)if(!row||![row.employeeId,row.employeeName].every(label)||!cents(row.salesCents)||!cents(row.targetCents)||!rate(row.rate)||!['complete','partial'].includes(row.coverage))invalid();
 for(const e of [...s.entries,...s.incompatible])if(!e||![e.employeeId,e.employeeName,e.messageId].every(label)||typeof e.id!=='string'||! /^[a-f0-9]{64}:\d$/.test(e.id)||!['target','sales'].includes(e.kind)||!['snapshot','increment'].includes(e.mode)||e.kind==='target'&&e.mode!=='snapshot'||!validDate(e.start)||!validDate(e.end)||e.start>e.end||e.amountCents===null||!cents(e.amountCents)||e.supersedes!==undefined&&!/^[a-f0-9]{64}:\d$/.test(e.supersedes))invalid();
 if(digest(JSON.stringify({scope:JSON.stringify([s.scope.tenant,s.scope.store,s.scope.workspace]),period:s.period,entries:s.entries,rows:s.rows}))!==s.snapshotHash)invalid();
 return s;
}
// Every existing path component is checked, including parents of the explicit root.
// Files are opened without following links where the host supports O_NOFOLLOW.
function safeDirectory(directory:string,create=false):boolean{
 const absolute=path.resolve(directory),root=path.parse(absolute).root;
 let current=root;
 for(const part of absolute.slice(root.length).split(path.sep).filter(Boolean)){
  current=path.join(current,part);
  try{const stat=fs.lstatSync(current);if(stat.isSymbolicLink()||!stat.isDirectory())return false;}
  catch(error){if(!create||(error as NodeJS.ErrnoException).code!=='ENOENT')return false;try{fs.mkdirSync(current);}catch(e){if((e as NodeJS.ErrnoException).code!=='EEXIST')throw e;}const stat=fs.lstatSync(current);if(stat.isSymbolicLink()||!stat.isDirectory())return false;}
 }
 return true;
}
function readFile(file:string,maxBytes:number):Buffer{
 if(!safeDirectory(path.dirname(file)))throw Error('artifact_unavailable');
 const stat=fs.lstatSync(file);if(!stat.isFile()||stat.isSymbolicLink()||stat.size>maxBytes)throw Error('artifact_unavailable');
 const fd=fs.openSync(file,fs.constants.O_RDONLY|(fs.constants.O_NOFOLLOW??0));
 try{const opened=fs.fstatSync(fd);if(!opened.isFile()||opened.size>maxBytes||opened.ino!==stat.ino||opened.dev!==stat.dev)throw Error('artifact_unavailable');const bytes=fs.readFileSync(fd);if(bytes.length>maxBytes)throw Error('artifact_unavailable');return bytes;}finally{fs.closeSync(fd);}
}
function exists(file:string){try{fs.lstatSync(file);return true;}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return false;throw error;}}
/** Hard-link publication is exclusive across processes; an existing fact is never replaced. */
function publish(file:string,bytes:string|Uint8Array,check:()=>void):boolean{
 if(!safeDirectory(path.dirname(file)))throw Error('artifact_unavailable');
 const temp=path.join(path.dirname(file),'.'+randomUUID()+'.tmp');
 const fd=fs.openSync(temp,'wx',0o600);
 try{fs.writeFileSync(fd,bytes);fs.fsyncSync(fd);}finally{fs.closeSync(fd);}
 try{check();if(!safeDirectory(path.dirname(file)))throw Error('artifact_unavailable');try{fs.linkSync(temp,file);return true;}catch(error){if((error as NodeJS.ErrnoException).code==='EEXIST')return false;throw error;}}finally{fs.unlinkSync(temp);}
}
function checkBudget(scope:BotReadScope){if(scope.signal.aborted)throw Error('authority_cancelled');if(!Number.isFinite(scope.deadline)||performance.now()>=scope.deadline)throw Error('authority_timeout');}
function bounded<T>(scope:BotReadScope,work:()=>Promise<T>):Promise<T>{
 checkBudget(scope);
 return new Promise((resolve,reject)=>{
  let done=false;
  const finish=(error:unknown,value?:T)=>{if(done)return;done=true;clearTimeout(timer);scope.signal.removeEventListener('abort',cancel);error?reject(error):resolve(value!);};
  const cancel=()=>finish(Error('authority_cancelled'));
  const timer=setTimeout(()=>finish(Error('authority_timeout')),Math.min(2147483647,Math.max(0,scope.deadline-performance.now())));
  scope.signal.addEventListener('abort',cancel,{once:true});
  Promise.resolve().then(()=>{checkBudget(scope);return work();}).then(value=>{try{checkBudget(scope);finish(null,value);}catch(error){finish(error);}},error=>finish(error));
 });
}
function defaultRender(snapshot:ManagerSnapshot):Promise<Uint8Array>{
 const zip=new AdmZip();for(const [name,xml] of Object.entries(salesWorkbookParts(snapshot,snapshot.scope))){zip.addFile(name,Buffer.from(xml,'utf8'));zip.getEntry(name)!.header.time=new Date(2000,0,1);}
 return Promise.resolve(zip.toBuffer());
}
interface SnapshotFile {ownerKey:string;snapshot:ManagerSnapshot;sha256:string;}
interface ArtifactFile {ownerKey:string;snapshotSha256:string;info:ManagerArtifact;}
export class ManagerArtifactStore {
 private readonly directory:string;
 private readonly render:(snapshot:ManagerSnapshot)=>Promise<Uint8Array>;
 constructor(options:{mode:'isolated-synthetic';directory:string;render?:(snapshot:ManagerSnapshot)=>Promise<Uint8Array>}){
  if(options.mode!=='isolated-synthetic'||typeof options.directory!=='string'||!path.isAbsolute(options.directory)||!safeDirectory(options.directory,true))throw Error('invalid_artifact_directory');
  this.directory=path.resolve(options.directory);this.render=options.render??defaultRender;
 }
 private location(key:string,id:string){return path.join(this.directory,key,id);}
 private stored(owner:ArtifactOwner,key:string,id:string):SnapshotFile|undefined{
  if(!hash(id))return undefined;
  try{const file=JSON.parse(readFile(path.join(this.location(key,id),'snapshot.json'),20_000_000).toString('utf8')) as SnapshotFile;
   if(file.ownerKey!==key||!hash(file.sha256)||digest(JSON.stringify(file.snapshot))!==file.sha256)return undefined;
   const snapshot=snapshotCopy(file.snapshot,owner);if(snapshot.snapshotHash!==id)return undefined;
   return {ownerKey:key,sha256:file.sha256,snapshot};
  }catch{return undefined;}
 }
 save(rawOwner:ArtifactOwner,rawSnapshot:ManagerSnapshot,checkActive:()=>void=()=>{}):ManagerSnapshot{
  const {owner,key}=identity(rawOwner),snapshot=snapshotCopy(rawSnapshot,owner),directory=this.location(key,snapshot.snapshotHash);
  checkActive();if(!safeDirectory(directory,true))throw Error('artifact_unavailable');
  const file=path.join(directory,'snapshot.json');
  if(!exists(file)){const stored:SnapshotFile={ownerKey:key,snapshot,sha256:digest(JSON.stringify(snapshot))};publish(file,JSON.stringify(stored),checkActive);}
  const stored=this.stored(owner,key,snapshot.snapshotHash);if(!stored)throw Error('artifact_unavailable');
  // Keep the first observation and history appendix. Neither participates in the
  // original hash or workbook; all other snapshot facts must still agree.
  if(!isDeepStrictEqual({...stored.snapshot,observedAt:'',incompatible:[]},{...snapshot,observedAt:'',incompatible:[]}))throw Error('artifact_snapshot_conflict');
  return structuredClone(stored.snapshot);
 }
 read(rawOwner:ArtifactOwner,snapshotHash:string):ManagerSnapshot|undefined{
  try{const {owner,key}=identity(rawOwner);return this.stored(owner,key,snapshotHash)?.snapshot;}catch{return undefined;}
 }
 artifact(rawOwner:ArtifactOwner,snapshotHash:string):{info:ManagerArtifact;bytes:Uint8Array}|undefined{
  try{
   const {owner,key}=identity(rawOwner),stored=this.stored(owner,key,snapshotHash);if(!stored)return undefined;
   const directory=this.location(key,snapshotHash),manifest=JSON.parse(readFile(path.join(directory,'artifact.json'),4096).toString('utf8')) as ArtifactFile,info=manifest.info;
   if(!keys(manifest,['ownerKey','snapshotSha256','info'])||manifest.ownerKey!==key||manifest.snapshotSha256!==stored.sha256||!keys(info,['snapshotHash','sha256','filename','byteLength'])||info.snapshotHash!==snapshotHash||!hash(info.sha256)||info.filename!=='sales-'+snapshotHash+'.xlsx'||!Number.isSafeInteger(info.byteLength)||info.byteLength<5||info.byteLength>20_000_000)return undefined;
   const bytes=readFile(path.join(directory,'sales.xlsx'),20_000_000);
   if(bytes.length!==info.byteLength||digest(bytes)!==info.sha256)return undefined;
   return {info:structuredClone(info),bytes:new Uint8Array(bytes)};
  }catch{return undefined;}
 }
 async export(rawOwner:ArtifactOwner,snapshotHash:string,rawBudget:BotReadScope,assertCurrent:()=>Promise<void>):Promise<ManagerArtifact>{
  const {owner,key}=identity(rawOwner),scope={signal:rawBudget.signal,deadline:rawBudget.deadline};
  const guard=async()=>{checkBudget(scope);try{await bounded(scope,assertCurrent);}catch(error){const code=error instanceof Error?error.message:'';throw Error(['authority_cancelled','authority_timeout','access_denied','access_not_open','access_home_unavailable','context_closed','snapshot_changed'].includes(code)?code:'authority_unavailable');}checkBudget(scope);};
  await guard();
  if(!hash(snapshotHash))throw Error('artifact_unavailable');
  const stored=this.stored(owner,key,snapshotHash);if(!stored)throw Error('artifact_unavailable');
  const directory=this.location(key,snapshotHash),lock=path.join(directory,'.export-lock');
  let acquired=false;
  try{
   while(!acquired){
    checkBudget(scope);if(!safeDirectory(directory))throw Error('artifact_unavailable');
    try{fs.mkdirSync(lock);acquired=true;}catch(error){if((error as NodeJS.ErrnoException).code!=='EEXIST'||!safeDirectory(lock))throw Error('artifact_unavailable');await bounded(scope,()=>new Promise(resolve=>setTimeout(resolve,10)));}
   }
   await guard();const cached=this.artifact(owner,snapshotHash);if(cached){await guard();return cached.info;}
   if(exists(path.join(directory,'artifact.json'))||exists(path.join(directory,'sales.xlsx')))throw Error('artifact_unavailable');
   if(!stored.snapshot.entries.length||!stored.snapshot.rows.length)throw Error('no_confirmed_sales_data');
   let bytes:Uint8Array;
   try{const rendered=await bounded(scope,()=>this.render(structuredClone(stored.snapshot)));bytes=new Uint8Array(rendered);}catch(error){checkBudget(scope);throw Error('workbook_failed');}
   await guard();
   if(bytes.length<5||bytes.length>20_000_000)throw Error('invalid_workbook_size');
   // Renderers cannot smuggle an arbitrary file through the file protocol seam.
   try{const zip=new AdmZip(Buffer.from(bytes));for(const name of ['[Content_Types].xml','xl/workbook.xml','xl/worksheets/sheet1.xml','xl/worksheets/sheet2.xml'])if(!zip.getEntry(name))throw Error();if(!zip.test())throw Error();}catch{throw Error('invalid_workbook');}
   const current=this.stored(owner,key,snapshotHash);if(!current||current.sha256!==stored.sha256)throw Error('artifact_unavailable');
   const info:ManagerArtifact={snapshotHash,sha256:digest(bytes),filename:'sales-'+snapshotHash+'.xlsx',byteLength:bytes.length};
   const manifest:ArtifactFile={ownerKey:key,snapshotSha256:stored.sha256,info};
   checkBudget(scope);if(!publish(path.join(directory,'sales.xlsx'),bytes,()=>checkBudget(scope)))throw Error('artifact_unavailable');
   if(!publish(path.join(directory,'artifact.json'),JSON.stringify(manifest),()=>checkBudget(scope)))throw Error('artifact_unavailable');
   const complete=this.artifact(owner,snapshotHash);if(!complete)throw Error('artifact_unavailable');return complete.info;
  }finally{if(acquired&&safeDirectory(lock))fs.rmdirSync(lock);}
 }
}
