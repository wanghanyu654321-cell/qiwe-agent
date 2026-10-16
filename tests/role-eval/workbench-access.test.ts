import {it,expect} from 'vitest';
import fs from 'node:fs';import os from 'node:os';import path from 'node:path';
import {WorkbenchAccessStore} from '../../src/role-eval/workbench-access.js';

it('persists one employee/store/job grant, deduplicates the same request after reopening, and keeps the audit result',()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'access-')),file=path.join(dir,'access.sqlite');let s=new WorkbenchAccessStore(file);
 const input={accountId:'employee-1',storeId:'b',roles:['marketing' as const,'manager' as const],active:true,expectedVersion:0,requestKey:'grant-1'};
 try{expect(s.change('admin',input)).toMatchObject({accountId:'employee-1',storeId:'b',roles:['manager','marketing'],version:1,active:true,updatedBy:'admin'});s.close();s=new WorkbenchAccessStore(file);expect(s.change('admin',input).version).toBe(1);expect(s.list()).toHaveLength(1);
  expect(()=>s.change('admin',{...input,storeId:'c'})).toThrow('grant_request_conflict');
 }finally{s.close();fs.rmSync(dir,{recursive:true});}
});
it('rejects stale writes, retains revoked history and does not let an old replay reactivate access',()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'access-')),s=new WorkbenchAccessStore(path.join(dir,'access.sqlite'));
 const input={accountId:'employee-1',storeId:'b',roles:['manager' as const],active:true,expectedVersion:0,requestKey:'grant-1'};
 try{s.change('admin',input);expect(()=>s.change('admin',{...input,requestKey:'stale'})).toThrow('grant_version_conflict');s.change('admin',{...input,active:false,expectedVersion:1,requestKey:'revoke-1'});expect(s.change('admin',input).version).toBe(1);expect(s.get('employee-1')).toMatchObject({version:2,active:false});expect(()=>s.change('other-admin',input)).toThrow('grant_request_conflict');}
 finally{s.close();fs.rmSync(dir,{recursive:true});}
});
it('two connections serialize updates; invalid roles and empty active grants never persist',()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'access-')),file=path.join(dir,'access.sqlite'),a=new WorkbenchAccessStore(file),b=new WorkbenchAccessStore(file);
 const input={accountId:'employee-1',storeId:'b',roles:['manager' as const],active:true,expectedVersion:0,requestKey:'grant-1'};
 try{for(const bad of [{...input,roles:[]},{...input,roles:['admin']},{...input,expectedVersion:-1},{...input,tenant:'evil'}])expect(()=>a.change('admin',bad as never)).toThrow('invalid_grant');expect(a.list()).toEqual([]);a.change('admin',input);expect(()=>b.change('admin',{...input,requestKey:'parallel'})).toThrow('grant_version_conflict');expect(b.get('employee-1')?.version).toBe(1);}
 finally{a.close();b.close();fs.rmSync(dir,{recursive:true});}
});
it('a synchronous business write holds the same authorization lock as revocation',()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'access-lock-')),file=path.join(dir,'access.sqlite'),a=new WorkbenchAccessStore(file),b=new WorkbenchAccessStore(file),input={accountId:'e',storeId:'b',roles:['manager' as const],active:true,expectedVersion:0,requestKey:'one'};
 try{const grant=a.change('admin',input);let writes=0;a.withCurrent(grant,()=>{expect(()=>b.change('admin',{...input,active:false,expectedVersion:1,requestKey:'revoke'})).toThrow();writes++;});expect(writes).toBe(1);b.change('admin',{...input,active:false,expectedVersion:1,requestKey:'revoke'});expect(()=>a.withCurrent(grant,()=>{writes++;})).toThrow('access_changed');expect(writes).toBe(1);}
 finally{a.close();b.close();fs.rmSync(dir,{recursive:true});}
});
it('one authorization database cannot be silently reused for another tenant after restart',()=>{const dir=fs.mkdtempSync(path.join(os.tmpdir(),'access-tenant-')),file=path.join(dir,'access.sqlite');let s=new WorkbenchAccessStore(file);try{s.bindTenant('tenant-one');s.close();s=new WorkbenchAccessStore(file);s.bindTenant('tenant-one');expect(()=>s.bindTenant('tenant-two')).toThrow('access_tenant_conflict');}finally{s.close();fs.rmSync(dir,{recursive:true});}});
