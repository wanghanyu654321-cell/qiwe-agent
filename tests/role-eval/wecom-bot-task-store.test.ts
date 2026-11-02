import {afterEach, describe, expect, it} from 'vitest';
import {mkdtempSync, readFileSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawn, execFileSync} from 'node:child_process';
import {DatabaseSync} from 'node:sqlite';
import {Worker} from 'node:worker_threads';
import ts from 'typescript';
import {BotTaskStore, type BotTaskOwner, type BotTaskRecord} from '../../src/role-eval/wecom-bot-task-store.js';

const directories:string[]=[];
const stores:BotTaskStore[]=[];
function open(){
 const directory=mkdtempSync(join(tmpdir(),'bot-task-store-'));directories.push(directory);
 const file=join(directory,'tasks.sqlite');const store=new BotTaskStore(file);stores.push(store);
 return {file,store};
}
const owner={tenantId:'tenant-a',storeId:'store-a',accountId:'account-a',workspaceJid:'home:account-a',role:'manager' as const,corpId:'corp-a',botId:'bot-a',memberId:'member-a',bindingVersion:1};
function reservation(){return {id:'a'.repeat(64),fingerprint:'b'.repeat(64),owner:{...owner},input:{kind:'native' as const,alias:'daily_report'},backend:{kind:'native' as const,taskId:'original-task',profileId:'manager-profile',workspaceJid:'web:original-workspace'}};}
function connect(file:string){const store=new BotTaskStore(file);stores.push(store);return store;}
function linked(store:BotTaskStore){const input=reservation();store.reserve(input);store.claimStart(owner,input.id);return store.finishStart(owner,input.id,1,{state:'linked',referenceId:'precise-run-1',detail:'original scheduler receipt'});}
function changeRow(file:string,id:string,change:(record:BotTaskRecord)=>void){const db=new DatabaseSync(file);try{const row=db.prepare('SELECT body FROM bot_task_refs WHERE id=?').get(id) as {body:string};const record=JSON.parse(row.body) as BotTaskRecord;change(record);db.prepare('UPDATE bot_task_refs SET body=? WHERE id=?').run(JSON.stringify(record),id);}finally{db.close();}}
function moduleUrl(){
 const compile=(source:string)=>'data:text/javascript;base64,'+Buffer.from(ts.transpileModule(source,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ESNext}}).outputText).toString('base64');
 const access=compile(readFileSync(fileURLToPath(new URL('../../src/role-eval/workbench-access.ts',import.meta.url)),'utf8'));
 return compile(readFileSync(fileURLToPath(new URL('../../src/role-eval/wecom-bot-task-store.ts',import.meta.url)),'utf8').replace("'./workbench-access.js'",JSON.stringify(access)));
}
async function processRace(file:string,kind:'start'|'cancel'){
 const script=`const {BotTaskStore}=await import(process.argv[1]);const input=JSON.parse(process.argv[3]);const store=new BotTaskStore(process.argv[2]);process.send('ready');process.once('message',()=>{try{const value=process.argv[4]==='start'?(store.reserve(input),store.claimStart(input.owner,input.id)):store.claimCancel(input.owner,input.id);process.send({claimed:!!value,attempt:value?.attempt,cancelAttempt:value?.cancellation.attempt});}catch(error){process.send({error:error.message});}finally{store.close();process.disconnect();}});`;
 const url=moduleUrl();const children=[0,1].map(()=>spawn(process.execPath,['--input-type=module','-e',script,url,file,JSON.stringify(reservation()),kind],{stdio:['ignore','pipe','pipe','ipc']}));
 try{
  await Promise.all(children.map(child=>new Promise<void>((resolve,reject)=>{child.once('message',()=>resolve());child.once('error',reject);child.once('exit',code=>{if(code)reject(Error(`child exit ${code}`));});})));
  const results=children.map(child=>new Promise<{claimed?:boolean;error?:string}>((resolve,reject)=>{child.once('message',value=>resolve(value as {claimed?:boolean;error?:string}));child.once('error',reject);}));
  for(const child of children)child.send('go');return await Promise.all(results);
 }finally{await Promise.all(children.map(child=>{
  if(child.exitCode!==null||child.signalCode!==null)return Promise.resolve();
  return new Promise<void>(resolve=>{child.once('exit',()=>resolve());child.kill();});
 }));}
}
afterEach(()=>{for(const store of stores.splice(0))store.close();for(const directory of directories.splice(0))rmSync(directory,{recursive:true,force:true});});

describe('BotTaskStore durable task references',()=>{
 it('reserves one event once and returns the same persisted fact through another connection',()=>{
  const {file,store}=open();const input=reservation();const first=store.reserve(input);
  const second=new BotTaskStore(file);stores.push(second);
  expect(second.get(owner,input.id)).toEqual({id:input.id,fingerprint:input.fingerprint,owner,input:input.input,backend:input.backend,state:'reserved',attempt:0,referenceId:null,detail:'',cancellation:{state:'none',attempt:0,detail:''}});
  expect(second.reserve(input)).toEqual(first);
 });
 it('deduplicates an event globally even after role, owner or backend remapping',()=>{
  const {store}=open();const input=reservation();store.reserve(input);
  const changes=[{...input,fingerprint:'c'.repeat(64)},{...input,owner:{...owner,storeId:'store-b'}},{...input,owner:{...owner,role:'qa' as const}},{...input,owner:{...owner,accountId:'account-b'}},{...input,input:{kind:'native' as const,alias:'other'}},{...input,backend:{...input.backend,taskId:'other-task'}}];
  for(const changed of changes)expect(()=>store.reserve(changed)).toThrow('task_conflict');
  expect(store.get(owner,input.id)?.backend).toEqual(input.backend);
 });
 it('matches every trusted owner field for reads, starts, finishes and cancellation',()=>{
  const {store}=open();const record=linked(store);
  const changes:BotTaskOwner[]=[{...owner,tenantId:'other'},{...owner,storeId:'other'},{...owner,accountId:'other'},{...owner,workspaceJid:'home:other'},{...owner,role:'qa'},{...owner,corpId:'other'},{...owner,botId:'other'},{...owner,memberId:'other'},{...owner,bindingVersion:2}];
  for(const changed of changes){expect(store.get(changed,record.id)).toBeUndefined();expect(store.claimStart(changed,record.id)).toBeUndefined();expect(store.claimCancel(changed,record.id)).toBeUndefined();expect(()=>store.finishStart(changed,record.id,1,{state:'unknown',detail:'wrong owner'})).toThrow('task_attempt_conflict');expect(()=>store.finishCancel(changed,record.id,1,{state:'unknown',detail:'wrong owner'})).toThrow('task_attempt_conflict');}
  expect(store.get(owner,record.id)).toEqual(record);
 });
 it('claims a start once across connections and links only its precise original receipt',()=>{
  const {store,file}=open();const input=reservation();store.reserve(input);
  expect(store.claimStart(owner,input.id)).toMatchObject({state:'attempting',attempt:1,referenceId:null});
  expect(connect(file).claimStart(owner,input.id)).toBeUndefined();
  const result=store.finishStart(owner,input.id,1,{state:'linked',referenceId:'original-run',detail:'request received'});
  expect(result).toMatchObject({state:'linked',attempt:1,referenceId:'original-run',cancellation:{state:'none',attempt:0}});
  expect(store.reserve(input)).toEqual(result);expect(store.claimStart(owner,input.id)).toBeUndefined();
  expect(()=>store.finishStart(owner,input.id,1,{state:'unknown',detail:'stale'})).toThrow('task_attempt_conflict');
 });
 it('retries only blocked starts and rejects stale attempt completion',()=>{
  const {store}=open();const input=reservation();store.reserve(input);store.claimStart(owner,input.id);
  store.finishStart(owner,input.id,1,{state:'blocked',detail:'backend unavailable before submission'});
  expect(store.claimStart(owner,input.id)).toMatchObject({state:'attempting',attempt:2});
  expect(()=>store.finishStart(owner,input.id,1,{state:'linked',referenceId:'stale-run',detail:''})).toThrow('task_attempt_conflict');
  expect(store.finishStart(owner,input.id,2,{state:'unknown',detail:'timeout after submission'})).toMatchObject({state:'unknown',referenceId:null});
  expect(store.claimStart(owner,input.id)).toBeUndefined();expect(store.claimCancel(owner,input.id)).toBeUndefined();
 });
 it('keeps attempting and unknown starts unreclaimable after a new process opens the file',()=>{
  const {store,file}=open();const input=reservation();store.reserve(input);store.claimStart(owner,input.id);
  const script=`const {BotTaskStore}=await import(process.argv[1]);const s=new BotTaskStore(process.argv[2]);const o=JSON.parse(process.argv[3]);console.log(JSON.stringify({record:s.get(o,process.argv[4]),claim:s.claimStart(o,process.argv[4])??null}));s.close();`;
  for(const state of ['attempting','unknown'] as const){
   if(state==='unknown')store.finishStart(owner,input.id,1,{state:'unknown',detail:'unknown side effect'});
   const output=JSON.parse(execFileSync(process.execPath,['--input-type=module','-e',script,moduleUrl(),file,JSON.stringify(owner),input.id],{encoding:'utf8'})) as {record:BotTaskRecord;claim:null};
   expect(output).toMatchObject({record:{state,attempt:1},claim:null});
  }
 });
 it('allows only one independent process to claim the same globally reserved event',async()=>{
  const {store,file}=open();const results=await processRace(file,'start');
  expect(results.filter(result=>result.claimed)).toHaveLength(1);expect(results.filter(result=>result.error)).toEqual([]);
  expect(store.get(owner,reservation().id)).toMatchObject({state:'attempting',attempt:1});
 });
 it('rejects replay under a remapped owner after an independent process restarts',()=>{
  const {store,file}=open();const input=reservation();store.reserve(input);
  const script=`const {BotTaskStore}=await import(process.argv[1]);const s=new BotTaskStore(process.argv[2]);try{s.reserve(JSON.parse(process.argv[3]));console.log('unexpected replay');}catch(error){console.log(error.message);}finally{s.close();}`;
  expect(execFileSync(process.execPath,['--input-type=module','-e',script,moduleUrl(),file,JSON.stringify({...input,owner:{...owner,storeId:'remapped-store',bindingVersion:2}})],{encoding:'utf8'}).trim()).toBe('task_conflict');
  expect(store.get(owner,input.id)).toMatchObject({owner:{storeId:'store-a',bindingVersion:1},attempt:0});
 });
 it('cancels only a linked reference and never changes its original start fact',()=>{
  const {store,file}=open();const input=reservation();store.reserve(input);expect(store.claimCancel(owner,input.id)).toBeUndefined();
  const record=linked(store);expect(store.claimCancel(owner,record.id)).toMatchObject({state:'linked',referenceId:'precise-run-1',cancellation:{state:'attempting',attempt:1}});
  expect(connect(file).claimCancel(owner,record.id)).toBeUndefined();
  expect(store.finishCancel(owner,record.id,1,{state:'requested',detail:'original cancellation request received'})).toMatchObject({state:'linked',attempt:1,referenceId:'precise-run-1',cancellation:{state:'requested',attempt:1}});
  expect(store.claimCancel(owner,record.id)).toBeUndefined();expect(store.claimStart(owner,record.id)).toBeUndefined();
 });
 it('retries only blocked cancellation and prevents stale and uncertain cancellation retries',()=>{
  const {store}=open();const record=linked(store);store.claimCancel(owner,record.id);store.finishCancel(owner,record.id,1,{state:'blocked',detail:'definitely not submitted'});
  expect(store.claimCancel(owner,record.id)?.cancellation).toMatchObject({state:'attempting',attempt:2});
  expect(()=>store.finishCancel(owner,record.id,1,{state:'requested',detail:'stale'})).toThrow('task_attempt_conflict');
  store.finishCancel(owner,record.id,2,{state:'unknown',detail:'timeout'});expect(store.claimCancel(owner,record.id)).toBeUndefined();
  expect(()=>store.finishCancel(owner,record.id,2,{state:'requested',detail:'late duplicate'})).toThrow('task_attempt_conflict');
 });
 it('allows only one independent process to claim cancellation of the saved run',async()=>{
  const {store,file}=open();const record=linked(store);const results=await processRace(file,'cancel');
  expect(results.filter(result=>result.claimed)).toHaveLength(1);expect(results.filter(result=>result.error)).toEqual([]);
  expect(store.get(owner,record.id)).toMatchObject({referenceId:'precise-run-1',cancellation:{state:'attempting',attempt:1}});
 });
 it('never reclaims uncertain cancellation after reopening and validates its completion independently',()=>{
  const {store,file}=open();const record=linked(store);store.claimCancel(owner,record.id);
  expect(connect(file).claimCancel(owner,record.id)).toBeUndefined();
  for(const outcome of [{state:'cancelled',detail:''},{state:'requested',detail:'',referenceId:'other-run'},{state:'requested',detail:'a'.repeat(2001)}])expect(()=>store.finishCancel(owner,record.id,1,outcome as Parameters<BotTaskStore['finishCancel']>[3])).toThrow('invalid_task_reference');
  expect(()=>store.finishCancel(owner,record.id,Number.MAX_SAFE_INTEGER+1,{state:'requested',detail:''})).toThrow('invalid_task_reference');
  store.finishCancel(owner,record.id,1,{state:'unknown',detail:'receipt unavailable'});
  expect(connect(file).claimCancel(owner,record.id)).toBeUndefined();expect(store.get(owner,record.id)).toMatchObject({state:'linked',referenceId:'precise-run-1',cancellation:{state:'unknown',attempt:1}});
 });
 it('rolls back reservations and claims when guard fails before or after the write',()=>{
  const {store}=open();const input=reservation();
  for(const failAt of [1,2]){let calls=0;expect(()=>store.reserve(input,()=>{if(++calls===failAt)throw Error('revoked');})).toThrow('revoked');expect(store.get(owner,input.id)).toBeUndefined();}
  store.reserve(input);let calls=0;expect(()=>store.claimStart(owner,input.id,()=>{if(++calls===2)throw Error('revoked');})).toThrow('revoked');expect(store.get(owner,input.id)).toMatchObject({state:'reserved',attempt:0});
  linked(store);calls=0;expect(()=>store.claimCancel(owner,input.id,()=>{if(++calls===2)throw Error('revoked');})).toThrow('revoked');expect(store.get(owner,input.id)?.cancellation).toEqual({state:'none',attempt:0,detail:''});
 });
 it('checks the guard after SQLite writer contention before committing a reservation',async()=>{
  const {store,file}=open();const worker=new Worker(`const {DatabaseSync}=require('node:sqlite');const {parentPort,workerData}=require('node:worker_threads');const db=new DatabaseSync(workerData);db.exec('BEGIN IMMEDIATE');parentPort.postMessage('locked');setTimeout(()=>{db.exec('COMMIT');db.close();},200);`,{eval:true,workerData:file});
  await new Promise<void>((resolve,reject)=>{worker.once('message',()=>resolve());worker.once('error',reject);});const deadline=Date.now()+50;
  try{expect(()=>store.reserve(reservation(),()=>{if(Date.now()>deadline)throw Error('expired');})).toThrow('expired');expect(store.get(owner,reservation().id)).toBeUndefined();}finally{await worker.terminate();}
 });
 it('uses independent snapshots even when guards mutate original inputs and callers mutate returned data',()=>{
  const {store}=open();const input=reservation();const record=store.reserve(input,()=>{input.owner.memberId='other';input.backend.taskId='other';input.input.alias='other';});
  expect(record.owner.memberId).toBe('member-a');expect(record.backend).toMatchObject({taskId:'original-task'});expect(record.input).toMatchObject({alias:'daily_report'});
  record.owner.memberId='returned-mutation';record.cancellation.state='requested';
  const lookup={...owner};store.claimStart(lookup,input.id,()=>{lookup.memberId='mutation';});
  expect(store.get(owner,input.id)).toMatchObject({owner:{memberId:'member-a'},state:'attempting',cancellation:{state:'none'}});
 });
 it('rejects accessor, proxy, unknown field and malformed identities without invoking getters',()=>{
  const {store}=open();let accesses=0;const input=reservation();Object.defineProperty(input.owner,'memberId',{enumerable:true,get(){accesses++;return 'member-a';}});
  expect(()=>store.reserve(input)).toThrow('invalid_task_reference');expect(accesses).toBe(0);
  const invalid:unknown[]=[{...reservation(),extra:true},{...reservation(),owner:{...owner,extra:true}},{...reservation(),owner:{...owner,role:'admin'}},{...reservation(),owner:{...owner,bindingVersion:0}},{...reservation(),owner:{...owner,tenantId:'a'.repeat(121)}},{...reservation(),owner:{...owner,workspaceJid:'a'.repeat(201)}},{...reservation(),id:"' OR 1=1 --"},{...reservation(),fingerprint:'bad'},{...reservation(),input:{kind:'native',alias:'../../arbitrary'}},{...reservation(),backend:{...reservation().backend,taskId:'../path'}},{...reservation(),backend:{kind:'training',requestKey:'request'}},new Proxy(reservation(),{})];
  for(const value of invalid)expect(()=>store.reserve(value as ReturnType<typeof reservation>)).toThrow('invalid_task_reference');
  expect(()=>store.get(owner,'*')).toThrow('invalid_task_reference');expect(()=>store.claimCancel(owner,'')).toThrow('invalid_task_reference');expect(store.get(owner,reservation().id)).toBeUndefined();
 });
 it('accepts bounded original Home/workspace IDs and restricts training to its trusted role',()=>{
  const {store}=open();const input=reservation();input.owner.workspaceJid='h'.repeat(200);input.backend.workspaceJid='w'.repeat(200);input.backend.taskId='t'.repeat(200);input.backend.profileId='p'.repeat(200);expect(store.reserve(input).owner.workspaceJid).toHaveLength(200);
  const training={id:'c'.repeat(64),fingerprint:'d'.repeat(64),owner:{...owner,role:'training' as const},input:{kind:'training' as const,mode:'lesson' as const,query:'合成资料',persona:'chief' as const},backend:{kind:'training' as const,requestKey:'q'.repeat(80)}};
  expect(store.reserve(training)).toMatchObject({input:{mode:'lesson'},backend:{requestKey:'q'.repeat(80)}});
  for(const value of [{...training,owner},{...training,backend:{kind:'training',requestKey:'q'.repeat(81)}},{...training,input:{...training.input,query:' '}},{...training,input:{...training.input,persona:'admin'}},{...training,input:{...training.input,extra:true}}])expect(()=>store.reserve(value as typeof training)).toThrow('invalid_task_reference');
 });
 it('rejects malformed outcome receipts, unsafe attempts and overflow without altering the stored fact',()=>{
  const {store,file}=open();const input=reservation();store.reserve(input);store.claimStart(owner,input.id);
  for(const outcome of [{state:'linked',referenceId:'',detail:''},{state:'linked',referenceId:'a'.repeat(201),detail:''},{state:'linked',referenceId:'../path',detail:''},{state:'linked',referenceId:'valid',detail:'',extra:true},{state:'cancelled',detail:''},{state:'unknown',detail:'a'.repeat(2001)}])expect(()=>store.finishStart(owner,input.id,1,outcome as Parameters<BotTaskStore['finishStart']>[3])).toThrow('invalid_task_reference');
  for(const attempt of [0,-1,1.5,Number.MAX_SAFE_INTEGER+1])expect(()=>store.finishStart(owner,input.id,attempt,{state:'unknown',detail:''})).toThrow('invalid_task_reference');
  expect(store.get(owner,input.id)).toMatchObject({state:'attempting',attempt:1});
  store.finishStart(owner,input.id,1,{state:'blocked',detail:''});changeRow(file,input.id,row=>{row.attempt=Number.MAX_SAFE_INTEGER;});expect(()=>store.claimStart(owner,input.id)).toThrow('invalid_task_reference');
  changeRow(file,input.id,row=>{row.attempt=1;row.state='linked';row.referenceId='exact-run';row.cancellation.attempt=Number.MAX_SAFE_INTEGER;row.cancellation.state='blocked';});
  expect(()=>store.claimCancel(owner,input.id)).toThrow('invalid_task_reference');expect(store.get(owner,input.id)?.cancellation.state).toBe('blocked');
 });
 it('creates its task and conversation tables without changing an existing report database',()=>{
  const {file}=open();const db=new DatabaseSync(file);try{db.exec('CREATE TABLE employee_reports(id TEXT PRIMARY KEY,body TEXT NOT NULL);');}finally{db.close();}
  connect(file).reserve(reservation());const inspector=new DatabaseSync(file);try{expect(inspector.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all()).toEqual([{name:'bot_conversation_current'},{name:'bot_conversation_events'},{name:'bot_task_refs'},{name:'employee_reports'}]);}finally{inspector.close();}
 });
});
