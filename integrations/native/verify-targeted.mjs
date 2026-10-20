import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {spawnSync} from 'node:child_process';
const here=path.dirname(fileURLToPath(import.meta.url)),project=path.resolve(here,'../..');
const source=process.argv[2];
if(!source||!path.isAbsolute(source))throw Error('Usage: node integrations/native/verify-targeted.mjs ABSOLUTE_NATIVE_SRC [--unpatched]');
const expected={'db.ts':'961b1eb108c7b5433f4c00fc68d2b2522823742399a26c913eb814230e755884','task-scheduler.ts':'7ac6c9475ad236eb87eba442d393a680cb1e68bbb8189232cbc7f590a5c038f8'};
for(const [name,hash] of Object.entries(expected))if(createHash('sha256').update(fs.readFileSync(path.join(source,name))).digest('hex')!==hash)throw Error('Native source changed: '+name);
const directory=fs.mkdtempSync(path.join(os.tmpdir(),'qiwe-native-targeted-'));
try{
 fs.cpSync(source,path.join(directory,'src'),{recursive:true});
 fs.mkdirSync(path.join(directory,'tests'));
 fs.copyFileSync(path.join(here,'scheduler-targeted.test.mts'),path.join(directory,'tests/scheduler-targeted.test.mts'));
 fs.writeFileSync(path.join(directory,'package.json'),'{"type":"module","private":true}');
 fs.writeFileSync(path.join(directory,'vitest.config.mts'),"export default {test:{include:['tests/*.test.mts'],fileParallelism:false}};");
 fs.symlinkSync(path.resolve(source,'../node_modules'),path.join(directory,'node_modules'),'junction');
 if(!process.argv.includes('--unpatched')){
  const {transformNative}=await import('./targeted-execution.mjs');
  const patch=path.join(here,'targeted-execution.patch');
  for(const args of [['apply','--unidiff-zero','--check',patch],['apply','--unidiff-zero',patch]]){
   const applied=spawnSync('git',args,{cwd:path.join(directory,'src'),encoding:'utf8'});
   if(applied.status!==0)throw Error(applied.stderr||'Unified Native patch failed');
  }
  for(const name of Object.keys(expected)){
   const wanted=transformNative(name,fs.readFileSync(path.join(source,name)));
   if(fs.readFileSync(path.join(directory,'src',name),'utf8').replaceAll('\r\n','\n')!==wanted)throw Error('Unified patch differs from anchored transform: '+name);
  }
 }
 const env={...process.env};
 for(const key of Object.keys(env))if(/SECRET|TOKEN|PASSWORD|API_KEY|MINICLAW|CLAUDE|ANTHROPIC|OPENAI|PROXY/i.test(key))delete env[key];
 env.QIWE_SOURCE_ROOT=project;
 const result=spawnSync(process.execPath,[path.join(project,'node_modules/vitest/vitest.mjs'),'run','--config',path.join(directory,'vitest.config.mts')],{cwd:directory,env,encoding:'utf8',timeout:60000});
 process.stdout.write(result.stdout??'');process.stderr.write(result.stderr??'');
 if(result.error)throw result.error;
 process.exitCode=result.status??1;
 if(process.exitCode===0&&process.argv.includes('--typecheck')){
  fs.copyFileSync(path.resolve(source,'../tsconfig.json'),path.join(directory,'tsconfig.json'));
  const check=spawnSync(process.execPath,[path.join(project,'node_modules/typescript/bin/tsc'),'--noEmit','--incremental','false'],{cwd:directory,env,encoding:'utf8',timeout:60000});
  process.stdout.write(check.stdout??'');process.stderr.write(check.stderr??'');
  if(check.error)throw check.error;process.exitCode=check.status??1;
 }
}finally{
 const resolved=fs.realpathSync(directory);
 if(path.dirname(resolved)!==fs.realpathSync(os.tmpdir())||!path.basename(resolved).startsWith('qiwe-native-targeted-'))throw Error('Unsafe temp cleanup');
 fs.rmSync(resolved,{recursive:true,force:true});
}
