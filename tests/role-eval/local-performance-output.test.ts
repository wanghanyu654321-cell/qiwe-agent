import {expect,it} from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {createRequire} from 'node:module';
import {spawnSync} from 'node:child_process';

it('retains a failed workflow and useful redacted assertion diagnostics in performance JSON',()=>{
 const original=new URL('../../examples/local-performance.mjs',import.meta.url);
 const directory=fs.mkdtempSync(path.join(os.tmpdir(),'qiwe-perf-fault-'));
 try{
  // npm test must also work after a fresh checkout, where dist is absent.
  const build=spawnSync(process.execPath,[createRequire(import.meta.url).resolve('typescript/bin/tsc'),'-p','tsconfig.build.json'],{cwd:fileURLToPath(new URL('../../',import.meta.url)),encoding:'utf8',timeout:15000,windowsHide:true});
  expect(build.error).toBeUndefined();expect(build.status,build.stdout+build.stderr).toBe(0);
  // Execute the actual harness, changing only one expected business result.
  // Relocate imports so the injected copy and its synthetic data stay temporary.
  let source=fs.readFileSync(original,'utf8').replaceAll(/from '(\.\.\/dist\/[^']+)'/g,(_,relative:string)=>'from '+JSON.stringify(new URL(relative,original).href));
  source=source.replace("from 'adm-zip'",'from '+JSON.stringify(pathToFileURL(createRequire(import.meta.url).resolve('adm-zip')).href));
  const assertion="assert.equal(query.result.status,'confirmed','confirmed_query_failed');";
  expect(source.split(assertion)).toHaveLength(2);
  source=source.replace(assertion,"assert.equal(query.result.status,key.endsWith('cold-first-use-0')?'synthetic-required-confirmed':'confirmed','synthetic failure detail '+process.cwd()+' '+os.homedir()+' '+os.tmpdir()+' '+new URL('.',import.meta.url).href);");
  const file=path.join(directory,'performance-fault.mjs');fs.writeFileSync(file,source);
  const child=spawnSync(process.execPath,[file],{encoding:'utf8',maxBuffer:12*1024*1024,timeout:30000,windowsHide:true});
  expect(child.error).toBeUndefined();expect(child.status).toBe(1);
  const result=JSON.parse(child.stdout),failed=result.samples.filter((s:{ok:boolean})=>!s.ok);
  expect(result.sampleCount).toBe(129);expect(result.errorCount).toBe(1);expect(result.cleanupSucceeded).toBe(true);
  expect(failed).toHaveLength(1);expect(failed[0]).toMatchObject({workflow:'pending-confirm-query',phase:'cold-first-use',error:{name:'AssertionError',code:'ERR_ASSERTION',actual:'confirmed',expected:'synthetic-required-confirmed',operator:'strictEqual'}});
  expect(failed[0].error.message).toContain('synthetic failure detail');
  expect(failed[0].error.stack).toContain('AssertionError');
  // Check decoded fields: raw JSON escapes Windows paths and can hide leaks.
  expect(failed[0].error.message).toContain('<local>');
  const roots=[directory,path.dirname(fileURLToPath(original)),process.cwd(),os.homedir(),os.tmpdir()];
  for(const field of Object.values(failed[0].error).filter((v):v is string=>typeof v==='string'))
   for(const root of roots)for(const form of new Set([root,root.replaceAll('\\','/'),pathToFileURL(root).href]))expect(field).not.toContain(form);
  expect(result.summary.find((s:{workflow:string;phase:string})=>s.workflow==='pending-confirm-query'&&s.phase==='cold-first-use')).toMatchObject({samples:1,errors:1});
 }finally{fs.rmSync(directory,{recursive:true,force:true});}
},40000);
