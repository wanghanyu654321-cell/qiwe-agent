import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {sealControlledLinuxCopy} from './linux-runtime.mjs';
let api={};try{api=await import('./local-pilot-host.mjs');}catch(e){if(e.code!=='ERR_MODULE_NOT_FOUND')throw e;}
const need=name=>{assert.equal(typeof api[name],'function',`${name} must implement explicit local initialization`);return api[name];};
const runId='11111111-1111-4111-8111-111111111111',root=path.resolve('.local/local-pilot-host-test'),copy=path.resolve('.local/controlled-copy');
test('requires explicit command and controlled copy only for first start',()=>{
 const parse=need('parseLocalPilotArguments');assert.deepEqual(parse(['start','--copy-root',copy,'--product-root',root,'--state-source',copy+'-state']),{command:'start',copyRoot:copy,productRoot:root,stateSource:copy+'-state'});assert.throws(()=>parse(['start','--copy-root',copy]),/local pilot arguments/);
 assert.deepEqual(parse(['status']),{command:'status'});assert.deepEqual(parse(['stop']),{command:'stop'});
 for(const args of [[],['start'],['start','--copy-root','relative'],['status','--copy-root',copy],['start','--image','other'],['stop','foreign'],['start','--copy-root',copy,'--copy-root',copy]])assert.throws(()=>parse(args),/local pilot arguments/);
});
test('uses network none without publishing ports and mounts readonly code/copy plus isolated product state',()=>{
 const args=need('localPilotContainerArguments')({root,copyRoot:copy,runId});
 assert.ok(args.includes('--network=none'));assert.ok(!args.some(v=>v.startsWith('--publish=')));
 for(const flag of ['--pull=never','--read-only','--cap-drop=ALL','--security-opt=no-new-privileges'])assert.ok(args.includes(flag));
 assert.deepEqual(args.filter(v=>v.startsWith('--mount=')),[`--mount=type=bind,source=${copy},target=/input,readonly`,`--mount=type=bind,source=${path.join(root,'code')},target=/source,readonly`,`--mount=type=bind,source=${path.join(root,'state')},target=/product-state`]);
 const env=args.filter(v=>v.startsWith('--env='));assert.ok(env.includes('--env=MINICLAW_EXECUTION_BOUNDARY=member-container-only'));assert.ok(env.includes('--env=PLUGIN_AUTO_SCAN=false'));assert.ok(!env.some(v=>/SECRET|TOKEN|API_KEY|BOT|ANTHROPIC|FEISHU/.test(v)));assert.ok(!args.some(v=>/docker.sock|--privileged|--volume/.test(v)));
 for(const bad of ['',path.parse(root).root,copy+',readonly=false'])assert.throws(()=>need('localPilotContainerArguments')({root:bad,copyRoot:copy,runId}),/pilot path/);
});
test('boot compiles unmodified original modules and launches actual main with observed paused gate',()=>{
 const boot=need('localPilotBootSource')();assert.match(boot,/verifyOriginalLinuxSqlite/);assert.match(boot,/transpileModule/);assert.match(boot,/await import\(.*index\.js/);assert.match(boot,/localPilotGate\.phase\(\)/);assert.match(boot,/'paused'/);assert.doesNotMatch(boot,/fixture|createUserSession|setSafe|commitRestore|createWecomBotPilot|fetch\(/);
});
test('status with no task manifest does not run Docker or start a host',async()=>{
 const tmp=fs.mkdtempSync(path.join(os.tmpdir(),'pilot-status-'));try{let calls=0;const s=await need('localPilotCommand')({command:'status'},{root:tmp,execute:()=>{calls++;throw Error('unexpected');}});assert.equal(s.state,'not-initialized');assert.equal(calls,0);}finally{fs.rmSync(tmp,{recursive:true,force:true});}
});
function manifest(tmp){const m={version:1,runId,name:'qiwe-local-pilot-'+runId,copyRoot:copy,codeHash:'a'.repeat(64)};fs.writeFileSync(path.join(tmp,'host.json'),JSON.stringify(m));return m;}
test('stop checks exact container label and preserves data without deleting containers',async()=>{
 const tmp=fs.mkdtempSync(path.join(os.tmpdir(),'pilot-stop-'));try{const m=manifest(tmp);fs.mkdirSync(path.join(tmp,'data'));fs.writeFileSync(path.join(tmp,'data','keep'),'owned local data');const calls=[];
 const execute=(_bin,args)=>{calls.push(args);if(args[0]==='context')return {status:0,stdout:'npipe:////./pipe/dockerDesktopLinuxEngine'};if(args.includes('inspect'))return {status:0,stdout:JSON.stringify({name:'/'+m.name,id:'c'.repeat(64),running:true,labels:{'qiwe.local.pilot':runId}})};return {status:0,stdout:''};};
 const s=await need('localPilotCommand')({command:'stop'},{root:tmp,execute});assert.equal(s.state,'stopped');assert.equal(calls.filter(a=>a.includes('stop')).length,1);assert.ok(!calls.some(a=>a.includes('rm')||a.includes('run')||a.includes('start')));assert.equal(fs.readFileSync(path.join(tmp,'data','keep'),'utf8'),'owned local data');
 }finally{fs.rmSync(tmp,{recursive:true,force:true});}
});
test('foreign container or remote daemon never receives stop',async()=>{
 for(const remote of [true,false]){const tmp=fs.mkdtempSync(path.join(os.tmpdir(),'pilot-foreign-'));try{const m=manifest(tmp),calls=[];const execute=(_bin,args)=>{calls.push(args);return args[0]==='context'?{status:0,stdout:remote?'tcp://remote:2375':'npipe:////./pipe/dockerDesktopLinuxEngine'}:{status:0,stdout:JSON.stringify({name:'/'+m.name,running:true,labels:{'qiwe.local.pilot':'foreign'}})};};await assert.rejects(need('localPilotCommand')({command:'stop'},{root:tmp,execute}),/local Docker|ownership/);assert.ok(!calls.some(a=>a.includes('stop')));}finally{fs.rmSync(tmp,{recursive:true,force:true});}}
});

test('refuses restarting the retired empty-state manifest without creating any network',async()=>{
 const tmp=fs.mkdtempSync(path.join(os.tmpdir(),'pilot-legacy-'));try{
  manifest(tmp);const calls=[];
  const execute=(_bin,args)=>{calls.push(args);return {status:0,stdout:'npipe:////./pipe/dockerDesktopLinuxEngine'};};
  await assert.rejects(need('localPilotCommand')({command:'start',copyRoot:copy,productRoot:root,stateSource:copy+'-state'},{root:tmp,execute}),/original product state/);
  assert.ok(!calls.some(a=>a.includes('start')||a.includes('run')||a.includes('network')));
 }finally{fs.rmSync(tmp,{recursive:true,force:true});}
});
test('missing original product input is rejected before staging empty data',async()=>{
 const tmp=fs.mkdtempSync(path.join(os.tmpdir(),'pilot-input-'));try{
  await assert.rejects(need('stageLocalPilot')({root:tmp,copyRoot:copy}),/original product/);
  assert.equal(fs.existsSync(path.join(tmp,'data')),false);assert.equal(fs.existsSync(path.join(tmp,'host.json')),false);
 }finally{fs.rmSync(tmp,{recursive:true,force:true});}
});
test('maintenance read permission is exact and never admits business writes or execution',()=>{
 const allowed=need('frontagentMaintenanceRead');
 for(const p of ['/api/groups','/api/agent-profiles','/api/local-product/config','/api/local-product/drafts','/api/local-product/manager','/api/local-product/training']){assert.equal(allowed('GET',p),true);assert.equal(allowed('POST',p),false);}
 for(const p of ['/api/messages','/api/tasks','/api/local-product/manager/confirm','/api/local-product/config/extra','/api/config','/api/auth/setup'])assert.equal(allowed('GET',p),false);
});

function originalStateFixture(t){
 const directory=fs.mkdtempSync(path.join(os.tmpdir(),'pilot-original-state-'));
 const root=path.join(directory,'host'),stateSource=path.join(directory,'original'),copyRoot=path.join(directory,'copy'),productRoot=path.join(directory,'product');
 for(const p of [root,copyRoot,productRoot,path.join(stateSource,'runtime/data/db')])fs.mkdirSync(p,{recursive:true});
 const originalDatabase=path.join(stateSource,'runtime/data/db/messages.db'),db=new DatabaseSync(originalDatabase);
 try{db.exec("CREATE TABLE users(id TEXT PRIMARY KEY,role TEXT,status TEXT); INSERT INTO users VALUES('synthetic-original-admin','admin','active')");}finally{db.close();}
 const originalHash=createHash('sha256').update(fs.readFileSync(originalDatabase)).digest('hex');
 const m={version:2,runId,name:'qiwe-local-pilot-'+runId,copyRoot,productRoot,stateSource,codeHash:'a'.repeat(64),snapshot:{sourceRoot:stateSource,targetRoot:path.join(root,'state')}};
 fs.writeFileSync(path.join(root,'host.json'),JSON.stringify(m));
 const calls=[],execute=(_bin,args)=>{calls.push(args);if(args[0]==='context')return {status:0,stdout:'npipe:////./pipe/dockerDesktopLinuxEngine'};return {status:0,stdout:JSON.stringify({name:'/'+m.name,id:'c'.repeat(64),running:false,labels:{'qiwe.local.pilot':runId}})};};
 t.after(()=>{
  const resolved=fs.realpathSync(directory);
  assert.equal(path.dirname(resolved),fs.realpathSync(os.tmpdir()));assert.ok(path.basename(resolved).startsWith('pilot-original-state-'));
  fs.rmSync(resolved,{recursive:true,force:true});
 });
 return {root,stateSource,copyRoot,productRoot,calls,execute,input:{command:'start',copyRoot,productRoot,stateSource},assertNoStartOrSourceChange(){
  assert.ok(!calls.some(args=>args.includes('start')||args.includes('run')),'rejected input must never reach Docker start/run');
  assert.equal(createHash('sha256').update(fs.readFileSync(originalDatabase)).digest('hex'),originalHash);
 }};
}

test('v2 start refuses a state-root junction back to the original before Docker start or run',async t=>{
 const f=originalStateFixture(t);
 fs.symlinkSync(f.stateSource,path.join(f.root,'state'),'junction');
 await assert.rejects(need('localPilotCommand')(f.input,{root:f.root,execute:f.execute}),/link|junction/i);
 f.assertNoStartOrSourceChange();
});

test('v2 start refuses an internal database junction back to the original before Docker start or run',async t=>{
 const f=originalStateFixture(t);
 fs.mkdirSync(path.join(f.root,'state/runtime/data'),{recursive:true});
 fs.symlinkSync(path.join(f.stateSource,'runtime/data/db'),path.join(f.root,'state/runtime/data/db'),'junction');
 await assert.rejects(need('localPilotCommand')(f.input,{root:f.root,execute:f.execute}),/link|junction/i);
 f.assertNoStartOrSourceChange();
});

test('v2 start refuses missing original messages.db without creating an empty database or starting Docker',async t=>{
 const f=originalStateFixture(t),database=path.join(f.root,'state/runtime/data/db/messages.db');
 fs.mkdirSync(path.dirname(database),{recursive:true});
 await assert.rejects(need('localPilotCommand')(f.input,{root:f.root,execute:f.execute}),/state database missing/i);
 assert.equal(fs.existsSync(database),false);
 f.assertNoStartOrSourceChange();
});

test('stage rejects a target inside the source before copy validation or creating a target directory',async t=>{
 const f=originalStateFixture(t),nested=path.join(f.stateSource,'new-host');
 await assert.rejects(need('stageLocalPilot')({root:nested,copyRoot:f.copyRoot,productRoot:f.productRoot,stateSource:f.stateSource}),/overlap/i);
 assert.equal(fs.existsSync(nested),false);
 f.assertNoStartOrSourceChange();
});
