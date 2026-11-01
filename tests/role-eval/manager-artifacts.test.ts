import {afterEach,expect,it,vi} from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {createRequire} from 'node:module';
import {pathToFileURL,fileURLToPath} from 'node:url';
import ts from 'typescript';
import AdmZip from 'adm-zip';
import {ManagerStore,type StaffContext} from '../../src/role-eval/manager-store.js';
import {ManagerArtifactStore,type ManagerSnapshot,type ArtifactOwner} from '../../src/role-eval/manager-artifacts.js';

const roots:string[]=[];
const actor:StaffContext={tenant:'synthetic-local',store:'b',workspace:'web:main',employeeId:'manager',employeeName:'=不执行<公式>'};
const owner:ArtifactOwner={accountId:'account-manager',actor};
const budget=(signal=new AbortController().signal,ms=3000)=>({signal,deadline:performance.now()+ms});
function setup(){
 const directory=fs.mkdtempSync(path.join(os.tmpdir(),'manager-artifacts-'));roots.push(directory);
 const ledger=new ManagerStore(':memory:');
 const report=ledger.receive(actor,'source_1','本月目标1000，本月销售250','2026-10-18');
 ledger.confirm(actor,report.id,report.hash,report.proposed.items);
 const snapshot=ledger.summary(actor,'2026-10-18','month',[actor]);ledger.close();
 return {directory,snapshot,store:new ManagerArtifactStore({mode:'isolated-synthetic',directory})};
}
afterEach(()=>{for(const directory of roots.splice(0))fs.rmSync(directory,{recursive:true,force:true});});
function files(directory:string,name:string):string[]{return fs.readdirSync(directory,{withFileTypes:true}).flatMap(e=>e.isDirectory()?files(path.join(directory,e.name),name):e.name===name?[path.join(directory,e.name)]:[]);}
function rehash(snapshot:ManagerSnapshot){snapshot.snapshotHash=createHash('sha256').update(JSON.stringify({scope:JSON.stringify([snapshot.scope.tenant,snapshot.scope.store,snapshot.scope.workspace]),period:snapshot.period,entries:snapshot.entries,rows:snapshot.rows})).digest('hex');return snapshot;}

it('persists the first immutable snapshot and returns detached copies after reopen',()=>{
 const {directory,snapshot,store}=setup(),first=store.save(owner,snapshot);
 snapshot.rows[0]!.employeeName='mutated';first.rows[0]!.employeeName='also-mutated';
 const reopened=new ManagerArtifactStore({mode:'isolated-synthetic',directory});
 const restored=reopened.read(owner,first.snapshotHash)!;
 expect(restored?.rows[0]?.employeeName).toBe('=不执行<公式>');
 const later={...restored,observedAt:'2026-10-19T00:00:00.000Z'};
 expect(reopened.save(owner,later).observedAt).toBe(first.observedAt);
 restored.entries[0]!.amountCents=0;
 expect(store.read(owner,first.snapshotHash)?.entries[0]?.amountCents).toBe(100000);
});
it('reuses the first saved snapshot when only un-hashed incompatible history changes',()=>{
 const {directory,store}=setup(),ledger=new ManagerStore(':memory:');
 try{
  const first=ledger.summary(actor,'2026-10-18','month',[actor]);store.save(owner,first);
  const report=ledger.receive(actor,'cross_month','2026-10-01至2026-11-01销售250','2026-10-18');
  expect(report.proposed.items).toHaveLength(1);ledger.confirm(actor,report.id,report.hash,report.proposed.items);
  const later=ledger.summary(actor,'2026-10-18','month',[actor]);
  expect(later.snapshotHash).toBe(first.snapshotHash);
  expect(later.entries).toEqual(first.entries);expect(later.rows).toEqual(first.rows);
  expect(first.incompatible).toHaveLength(0);expect(later.incompatible).toHaveLength(1);
  const reused=store.save(owner,later);
  expect(reused).toEqual(first);expect(reused.incompatible).toHaveLength(0);
  const reopened=new ManagerArtifactStore({mode:'isolated-synthetic',directory});
  expect(reopened.read(owner,first.snapshotHash)).toEqual(first);
 }finally{ledger.close();}
});
it('rejects changed aggregate facts despite an unchanged original snapshot hash',()=>{
 const {snapshot,store}=setup();store.save(owner,snapshot);
 const altered={...snapshot,salesCents:26000};
 expect(altered.snapshotHash).toBe(snapshot.snapshotHash);
 expect(()=>store.save(owner,altered)).toThrow('artifact_snapshot_conflict');
 expect(store.read(owner,snapshot.snapshotHash)).toEqual(snapshot);
});
it('isolates snapshots and artifact bytes by account, employee, store, and workspace',async()=>{
 const {snapshot,store}=setup();store.save(owner,snapshot);
 await store.export(owner,snapshot.snapshotHash,budget(),async()=>{});
 for(const other of [{...owner,accountId:'other'},{...owner,actor:{...actor,employeeId:'other'}},{...owner,actor:{...actor,store:'other'}},{...owner,actor:{...actor,workspace:'other'}}]){
  expect(store.read(other,snapshot.snapshotHash)).toBeUndefined();expect(store.artifact(other,snapshot.snapshotHash)).toBeUndefined();
 }
});
it('exports real original XLSX tabs, numeric cached formulas, protected inline names, and source messages',async()=>{
 const {snapshot,store,directory}=setup();store.save(owner,snapshot);
 const info=await store.export(owner,snapshot.snapshotHash,budget(),async()=>{});
 const artifact=store.artifact(owner,snapshot.snapshotHash)!;
 expect(info).toEqual(artifact.info);expect(info.byteLength).toBe(artifact.bytes.length);
 expect(info.sha256).toBe(createHash('sha256').update(artifact.bytes).digest('hex'));
 expect(info.filename).toBe('sales-'+snapshot.snapshotHash+'.xlsx');expect(JSON.stringify(info)).not.toContain(directory);
 const zip=new AdmZip(Buffer.from(artifact.bytes));
 expect(zip.getEntries().map(e=>e.entryName)).toContain('[Content_Types].xml');
 expect(zip.readAsText('xl/workbook.xml')).toContain('name="经营汇总"');
 expect(zip.readAsText('xl/workbook.xml')).toContain('name="汇报明细"');
 const sheet=zip.readAsText('xl/worksheets/sheet1.xml');
 expect(sheet).toContain('t="inlineStr"><is><t xml:space="preserve">=不执行&lt;公式&gt;');
 expect(sheet).toContain('C8/B8,&quot;待核实&quot;)</f><v>0.25</v>');
 expect(sheet).toContain('C8-B8,&quot;待核实&quot;)</f><v>-750</v>');
 expect(zip.readAsText('xl/worksheets/sheet2.xml')).toContain('source_1');
 artifact.bytes.fill(0);
 expect(new ManagerArtifactStore({mode:'isolated-synthetic',directory}).artifact(owner,snapshot.snapshotHash)?.info).toEqual(info);
});
it('two instances concurrently publish one complete reusable original workbook',async()=>{
 const {directory,snapshot,store}=setup(),other=new ManagerArtifactStore({mode:'isolated-synthetic',directory});
 store.save(owner,snapshot);other.save(owner,{...snapshot,observedAt:'2026-10-19T00:00:00.000Z'});
 const info=await Promise.all([store.export(owner,snapshot.snapshotHash,budget(),async()=>{}),other.export(owner,snapshot.snapshotHash,budget(),async()=>{})]);
 expect(info[0]).toEqual(info[1]);expect(files(directory,'sales.xlsx')).toHaveLength(1);expect(files(directory,'artifact.json')).toHaveLength(1);
 expect(other.read(owner,snapshot.snapshotHash)?.observedAt).toBe(snapshot.observedAt);
});
it('separate processes concurrently publish the same complete artifact',async()=>{
 const {directory,snapshot,store}=setup();store.save(owner,snapshot);
 const runtime=path.join(directory,'child-runtime');fs.mkdirSync(runtime);
 const require=createRequire(import.meta.url),zipUrl=pathToFileURL(require.resolve('adm-zip')).href;
 for(const name of ['manager-artifacts','unified-workbook','manager-report']){
  const source=fs.readFileSync(fileURLToPath(new URL('../../src/role-eval/'+name+'.ts',import.meta.url)),'utf8');
  const compiled=ts.transpileModule(source,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ESNext}}).outputText.replaceAll("'./manager-report.js'","'./manager-report.mjs'").replaceAll("'./unified-workbook.js'","'./unified-workbook.mjs'").replaceAll("'adm-zip'",JSON.stringify(zipUrl));
  fs.writeFileSync(path.join(runtime,name+'.mjs'),compiled);
 }
 const code=`import {ManagerArtifactStore} from ${JSON.stringify(pathToFileURL(path.join(runtime,'manager-artifacts.mjs')).href)};const store=new ManagerArtifactStore({mode:'isolated-synthetic',directory:${JSON.stringify(directory)}});const info=await store.export(${JSON.stringify(owner)},${JSON.stringify(snapshot.snapshotHash)},{signal:new AbortController().signal,deadline:performance.now()+3000},async()=>{});console.log(JSON.stringify(info));`;
 const run=()=>promisify(execFile)(process.execPath,['--input-type=module','--eval',code],{windowsHide:true});
 const results=await Promise.all([run(),run()]);
 expect(JSON.parse(results[0]!.stdout)).toEqual(JSON.parse(results[1]!.stdout));
 expect(store.artifact(owner,snapshot.snapshotHash)?.info).toEqual(JSON.parse(results[0]!.stdout));
 expect(files(directory,'sales.xlsx')).toHaveLength(1);expect(files(directory,'artifact.json')).toHaveLength(1);
});
it('same snapshots render deterministic ZIP bytes in separate artifact roots',async()=>{
 const a=setup(),b=setup();a.store.save(owner,a.snapshot);b.store.save(owner,a.snapshot);
 expect((await a.store.export(owner,a.snapshot.snapshotHash,budget(),async()=>{})).sha256).toBe((await b.store.export(owner,a.snapshot.snapshotHash,budget(),async()=>{})).sha256);
});
it('validates scope, hash, integer cents, metric and finite rates before persistence',()=>{
 const {snapshot,store,directory}=setup();
 const bad:ManagerSnapshot[]=[{...snapshot,scope:{...snapshot.scope,store:'other'}},{...snapshot,snapshotHash:'a'.repeat(64)},{...snapshot,metric:'other' as never},{...snapshot,salesCents:NaN},{...snapshot,rate:Infinity},rehash({...snapshot,rows:[{...snapshot.rows[0]!,salesCents:1.5}]})];
 for(const value of bad)expect(()=>store.save(owner,value)).toThrow('invalid_artifact_snapshot');
 expect(files(directory,'snapshot.json')).toHaveLength(0);
});
it('rejects traversal ids and does not publish snapshots when the active guard fails',()=>{
 const {snapshot,store,directory}=setup();
 expect(store.read(owner,'../snapshot.json')).toBeUndefined();expect(store.artifact(owner,'../sales.xlsx')).toBeUndefined();
 expect(()=>store.save(owner,snapshot,()=>{throw Error('authority_cancelled');})).toThrow('authority_cancelled');
 expect(files(directory,'snapshot.json')).toHaveLength(0);
});
it.each(['snapshot.json','sales.xlsx','artifact.json'])('treats tampered %s as unavailable and refuses replacement',async name=>{
 const {snapshot,store,directory}=setup();store.save(owner,snapshot);await store.export(owner,snapshot.snapshotHash,budget(),async()=>{});
 const file=files(directory,name)[0]!;fs.writeFileSync(file,'corrupt');
 expect(store.artifact(owner,snapshot.snapshotHash)).toBeUndefined();
 await expect(store.export(owner,snapshot.snapshotHash,budget(),async()=>{})).rejects.toThrow();
 expect(fs.readFileSync(file,'utf8')).toBe('corrupt');
 if(name==='snapshot.json')expect(()=>store.save(owner,snapshot)).toThrow();
});
it('rejects a snapshot directory junction without reading or writing its target',async()=>{
 const {snapshot,store,directory}=setup();store.save(owner,snapshot);
 const snapshotFile=files(directory,'snapshot.json')[0]!,snapshotDirectory=path.dirname(snapshotFile);
 const external=fs.mkdtempSync(path.join(os.tmpdir(),'artifact-external-'));roots.push(external);
 fs.writeFileSync(path.join(external,'snapshot.json'),fs.readFileSync(snapshotFile));
 fs.rmSync(snapshotDirectory,{recursive:true});fs.symlinkSync(external,snapshotDirectory,'junction');
 expect(store.read(owner,snapshot.snapshotHash)).toBeUndefined();
 await expect(store.export(owner,snapshot.snapshotHash,budget(),async()=>{})).rejects.toThrow();
 expect(fs.readdirSync(external)).toEqual(['snapshot.json']);
});
it.each(['cancel','timeout','revoke'])('does not publish a late render after %s',async kind=>{
 // The deadline starts at export, but this scenario must expire during rendering.
 // Real disk/CPU load must not consume that budget before the renderer starts.
 vi.useFakeTimers({toFake:['setTimeout','clearTimeout','performance']});
 try{
  const {snapshot,directory}=setup(),controller=new AbortController();
  let finish!:(bytes:Uint8Array)=>void,started!:()=>void;
  const rendering=new Promise<void>(resolve=>{started=resolve;});
  const store=new ManagerArtifactStore({mode:'isolated-synthetic',directory,render:async()=>{started();return new Promise(resolve=>{finish=resolve;});}});
  store.save(owner,snapshot);let revoked=false;
  const pending=store.export(owner,snapshot.snapshotHash,budget(controller.signal,kind==='timeout'?25:1000),async()=>{if(revoked)throw Error('access_denied');});
  const rejected=expect(pending).rejects.toThrow(kind==='cancel'?'authority_cancelled':kind==='timeout'?'authority_timeout':'access_denied');
  await rendering;
  if(kind==='cancel')controller.abort();if(kind==='revoke')revoked=true;
  if(kind==='timeout')await vi.advanceTimersByTimeAsync(25);
  if(kind==='revoke')finish(new Uint8Array([80,75,3,4,5]));
  await rejected;
  if(kind!=='revoke')finish(new Uint8Array([80,75,3,4,5]));
  await vi.advanceTimersByTimeAsync(15);
  expect(store.artifact(owner,snapshot.snapshotHash)).toBeUndefined();expect(files(directory,'sales.xlsx')).toHaveLength(0);expect(files(directory,'artifact.json')).toHaveLength(0);
 }finally{vi.useRealTimers();}
});
it('rechecks authority even on cached exports and masks arbitrary renderer errors',async()=>{
 const {snapshot,store,directory}=setup();store.save(owner,snapshot);await store.export(owner,snapshot.snapshotHash,budget(),async()=>{});
 await expect(store.export(owner,snapshot.snapshotHash,budget(),async()=>{throw Error('access_denied');})).rejects.toThrow('access_denied');
 const otherOwner={...owner,accountId:'broken-render'};
 const broken=new ManagerArtifactStore({mode:'isolated-synthetic',directory,render:async()=>{throw Error('secret-token-private-path');}});broken.save(otherOwner,snapshot);
 await expect(broken.export(otherOwner,snapshot.snapshotHash,budget(),async()=>{})).rejects.toThrow('workbook_failed');
});
it('rejects early expired and cancelled budgets before any export publication',async()=>{
 const {snapshot,store,directory}=setup();store.save(owner,snapshot);
 const cancelled=new AbortController();cancelled.abort();
 await expect(store.export(owner,snapshot.snapshotHash,budget(cancelled.signal),async()=>{})).rejects.toThrow('authority_cancelled');
 await expect(store.export(owner,snapshot.snapshotHash,budget(undefined,-1),async()=>{})).rejects.toThrow('authority_timeout');
 expect(files(directory,'sales.xlsx')).toHaveLength(0);
});
it('checks cancellation while waiting for authority even if authority never settles',async()=>{
 const {snapshot,store,directory}=setup();store.save(owner,snapshot);
 await expect(store.export(owner,snapshot.snapshotHash,budget(undefined,20),()=>new Promise(()=>{}))).rejects.toThrow('authority_timeout');
 expect(files(directory,'sales.xlsx')).toHaveLength(0);
});
it('treats unexpected manifest fields and corrupt ownership as unavailable',async()=>{
 const {snapshot,store,directory}=setup();store.save(owner,snapshot);await store.export(owner,snapshot.snapshotHash,budget(),async()=>{});
 const file=files(directory,'artifact.json')[0]!,original=JSON.parse(fs.readFileSync(file,'utf8'));
 fs.writeFileSync(file,JSON.stringify({...original,info:{...original.info,path:'private-path'}}));
 expect(store.artifact(owner,snapshot.snapshotHash)).toBeUndefined();
 fs.writeFileSync(file,JSON.stringify({...original,ownerKey:'a'.repeat(64)}));
 expect(store.artifact(owner,snapshot.snapshotHash)).toBeUndefined();
});
it('rejects renderer payloads outside the official byte bounds and invalid ZIPs',async()=>{
 const {snapshot,directory}=setup();
 for(const bytes of [new Uint8Array(4),new Uint8Array(20_000_001),new Uint8Array([80,75,3,4,5])]){
  const account={...owner,accountId:'size-'+bytes.length},store=new ManagerArtifactStore({mode:'isolated-synthetic',directory,render:async()=>bytes});store.save(account,snapshot);
  await expect(store.export(account,snapshot.snapshotHash,budget(),async()=>{})).rejects.toThrow(bytes.length===5?'invalid_workbook':'invalid_workbook_size');
  expect(store.artifact(account,snapshot.snapshotHash)).toBeUndefined();
 }
 expect(files(directory,'sales.xlsx')).toHaveLength(0);
});
