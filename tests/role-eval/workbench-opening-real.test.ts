import {it,expect} from 'vitest';
import fs from 'node:fs';import os from 'node:os';import path from 'node:path';
import * as opening from '../../src/role-eval/workbench-opening.js';
import {WorkbenchAccessStore} from '../../src/role-eval/workbench-access.js';

function setup(origin='http://127.0.0.1:39130'){
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'local-opening-')),file=path.join(dir,'grants.sqlite'),store=new WorkbenchAccessStore(file);
 let admin=true,disabled=false,profiles=0,alias=false;
 const sharedUser={id:'employee',role:'member',status:'active',must_change_password:false};
 const native={authenticate:async(cookie:string)=>cookie==='employee'&&alias?sharedUser:({id:cookie,role:cookie==='admin'&&admin?'admin':'member',status:'active',must_change_password:false}),employees:async()=>[{id:'employee',role:'member',status:disabled?'disabled':'active'},{id:'other',role:'member',status:'active'}],groups:async()=>{if(alias)sharedUser.id='other';return {groups:{'web:employee':{is_my_home:true}}};},skills:async()=>['original-skill'],profiles:()=>({list:async()=>[],create:async()=>{profiles++;return {};}})};
 const options={origin,accountId:'employee',tenantId:'test-tenant',stores:[{id:'b',name:'B'}],templates:[{key:'marketing' as const,name:'Marketing',skills:['original-skill'],payload:{name:'Existing marketing'}}],store,journalDirectory:path.join(dir,'journal'),native};
 const factory=Reflect.get(opening,'createLocalPilotWorkbenchOpening') as typeof opening.createWorkbenchOpening|undefined;
 const api=(factory??opening.createWorkbenchOpening)(options);
 const request=(route='',body?:unknown,cookie='admin',requestOrigin=origin)=>api.handle(new Request(origin+'/api/local-product/access'+route,{method:body===undefined?'GET':'POST',headers:{cookie,origin:requestOrigin},...(body===undefined?{}:{body:JSON.stringify(body)})}));
 const grant=(extra={})=>({accountId:'employee',storeId:'b',roles:['marketing'],active:true,expectedVersion:0,requestKey:'opening-1',...extra});
 return {api,request,grant,options,file,store,aliasDuringHome:()=>{alias=true;},disable:()=>{disabled=true;},demote:()=>{admin=false;},profiles:()=>profiles,close:()=>{store.close();fs.rmSync(dir,{recursive:true});}};
}

it('a reused Native identity object changed during Home lookup cannot switch the selected employee',async()=>{
 const s=setup();try{
  expect((await s.request('',s.grant())).status).toBe(200);
  s.store.change('admin',{...s.grant(),accountId:'other',roles:['marketing'],requestKey:'existing-other'});
  s.aliasDuringHome();await expect(s.api.authorize('employee')).rejects.toThrow();
 }finally{s.close();}
});

it('local administrator opens only the selected existing employee and grant survives SQLite reopen without installing roles',async()=>{
 const s=setup();try{
  expect((await s.request('',s.grant())).status).toBe(200);
  expect((await s.request('',s.grant())).status).toBe(200);
  const reader=new WorkbenchAccessStore(s.file);try{expect(reader.get('employee')).toMatchObject({roles:['marketing'],version:1,updatedBy:'admin'});}finally{reader.close();}
  const catalog=await(await s.request()).json();expect(catalog.mode).toBe('controlled-real-pilot');expect(catalog.users.map((x:{id:string})=>x.id)).toEqual(['employee']);
  expect((await s.request('',s.grant({accountId:'other',requestKey:'other'}))).status).toBe(403);
  s.store.change('admin',{...s.grant(),accountId:'other',roles:['marketing'],requestKey:'preexisting-other'});
  expect((await s.request('/self',undefined,'other')).status).toBe(403);
  await expect(s.api.authorize('other')).rejects.toThrow('access_denied');
  expect((await s.request('/prepare',{},'employee')).status).toBe(403);expect(s.profiles()).toBe(0);
 }finally{s.close();}
});

it('local opening keeps origin checks, current administrator and employee checks, and immediate revocation',async()=>{
 const s=setup();try{
  expect((await s.request('',s.grant(),'admin','http://evil.invalid')).status).toBe(403);
  expect((await s.request('',s.grant(),'employee')).status).toBe(403);
  expect((await s.request('',s.grant())).status).toBe(200);
  const context=await s.api.authorize('employee');
  expect((await s.request('',s.grant({active:false,expectedVersion:1,requestKey:'revoke'}))).status).toBe(200);
  await expect(s.api.assertCurrent('employee',context)).rejects.toThrow();
  s.disable();expect((await s.request('',s.grant({expectedVersion:2,requestKey:'disabled'}))).status).toBe(403);
  s.demote();expect((await s.request()).status).toBe(403);
 }finally{s.close();}
});

it('local opening does not widen its selected employee, store or template after construction',async()=>{
 const s=setup();try{
  s.options.accountId='other';s.options.stores.push({id:'c',name:'C'});s.options.templates[0]!.key='manager' as 'marketing';
  expect((await s.request('',s.grant({accountId:'other'}))).status).toBe(403);
  expect((await s.request('',s.grant({storeId:'c'}))).status).toBe(403);
  expect((await s.request('',s.grant())).status).toBe(200);
 }finally{s.close();}
});

it('local opening refuses a public origin without weakening the original HTTPS-only opening',()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'opening-origin-')),store=new WorkbenchAccessStore(path.join(dir,'access.sqlite'));
 try{
  const factory=Reflect.get(opening,'createLocalPilotWorkbenchOpening');expect(typeof factory).toBe('function');
  const base={origin:'https://example.com',accountId:'employee',tenantId:'test',stores:[{id:'b',name:'B'}],templates:[],store,journalDirectory:dir,native:{authenticate:async()=>null,employees:async()=>[],groups:async()=>null,skills:async()=>[],profiles:()=>({list:async()=>[],create:async()=>({})})}};
  expect(()=>factory(base)).toThrow('invalid_local_opening');
  expect(()=>opening.createWorkbenchOpening({...base,origin:'http://127.0.0.1:39130'} as unknown as opening.WorkbenchOpeningOptions)).toThrow('invalid_opening_catalog');
 }finally{store.close();fs.rmSync(dir,{recursive:true});}
});
