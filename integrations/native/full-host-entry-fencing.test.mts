import {afterAll,expect,it,vi} from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
const isolated=await vi.hoisted(async()=>{
 const fs=await import('node:fs'),os=await import('node:os'),path=await import('node:path');
 process.env.CORS_ALLOWED_ORIGINS='http://127.0.0.1:39130';
 process.env.CORS_ALLOW_LOCALHOST='false';
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'qiwe-entry-fence-'));
 return {root,data:path.join(root,'data'),store:path.join(root,'data/db')};
});
vi.mock('../src/config.js',async original=>({...await original<any>(),DATA_DIR:isolated.data,STORE_DIR:isolated.store}));
import {initDatabase,closeDatabase,createUser,createUserSession,getSessionWithUser,getUserCount} from '../src/db.js';
import {createAppointmentBootGate} from '../src/appointment-boot-gate.js';
import {createAppForTest} from '../src/web.js';
import {hashPassword,signSessionToken} from '../src/auth.js';

afterAll(()=>{if(path.dirname(fs.realpathSync(isolated.root))!==fs.realpathSync(os.tmpdir()))throw Error('UNSAFE_TEST_CLEANUP');fs.rmSync(isolated.root,{recursive:true,force:true});});

it('initializes through original setup and login while every business entry remains paused',async()=>{
 initDatabase();const gate=createAppointmentBootGate('appointment'),app=createAppForTest({appointmentBootGate:gate} as any);
 const origin='http://127.0.0.1:39130',credentials={username:'local_init_admin',password:'Synthetic-setup-test-123456!'};
 const post=(route:string,requestOrigin?:string)=>app.request(origin+route,{method:'POST',headers:{'content-type':'application/json',...(requestOrigin?{origin:requestOrigin}:{})},body:JSON.stringify(credentials)});
 try{
  expect(getUserCount(true)).toBe(0);
  expect((await app.request(origin+'/api/auth/status')).status).toBe(200);
  expect((await app.request(origin+'/api/auth/register/status')).status).toBe(200);
  expect((await app.request(origin+'/api/auth/me')).status).toBe(401);
  expect((await post('/api/auth/setup')).status).toBe(403);
  expect((await post('/api/auth/setup','https://foreign.invalid')).status).toBe(403);
  expect(getUserCount(true)).toBe(0);
  for(const foreignOrigin of ['http://foreign.invalid','http://127.0.0.1:39999']){
   const spoofed=await app.request(foreignOrigin+'/api/auth/setup',{method:'POST',headers:{origin:foreignOrigin,'content-type':'application/json'},body:JSON.stringify(credentials)});
   expect(spoofed.status).toBe(403);expect(getUserCount(true)).toBe(0);
  }
  const begin=vi.spyOn(gate,'beginWrite'),finish=vi.spyOn(gate,'finishWrite');
  const setup=await post('/api/auth/setup',origin);
  expect(setup.status).toBe(201);expect((await setup.json()).user.role).toBe('admin');expect(getUserCount(true)).toBe(1);
  expect(finish).toHaveBeenCalledWith(begin.mock.results[0].value);begin.mockRestore();finish.mockRestore();
  expect((await post('/api/auth/setup',origin)).status).toBe(403);expect(getUserCount(true)).toBe(1);
  const login=await post('/api/auth/login',origin);expect(login.status).toBe(200);
  const cookie=login.headers.get('set-cookie')!.split(';')[0]!;
  const me=await app.request(origin+'/api/auth/me',{headers:{cookie}});expect(me.status).toBe(200);expect((await me.json()).user.role).toBe('admin');
  for(const [route,method] of [['/api/messages','POST'],['/api/auth/logout','POST'],['/api/config','GET'],['/api/auth/setup','GET'],['/api/auth/status','POST']] as const){
   expect((await app.request(origin+route,{method,headers:{cookie,origin}})).status).toBe(503);
  }
  expect(gate.phase()).toBe('paused');
 }finally{closeDatabase();}
});

it('maintenance refuses an original auth mutation before it can revoke a saved session',async()=>{
 initDatabase();
 const now=new Date().toISOString(),id='entry-fence-admin',session='d'.repeat(64);
 createUser({id,username:id,password_hash:await hashPassword('Synthetic-local-123456!'),display_name:'Synthetic',role:'admin',status:'active',must_change_password:false,created_at:now,updated_at:now});
 createUserSession({id:session,user_id:id,ip_address:null,user_agent:'synthetic',created_at:now,last_active_at:now,expires_at:new Date(Date.now()+3600000).toISOString()});
 const gate=createAppointmentBootGate('appointment');
 const app=createAppForTest({appointmentBootGate:gate} as any);
 try{
  const before=getSessionWithUser(session);
  const response=await app.request('/api/auth/logout',{method:'POST',headers:{cookie:'miniclaw_session='+signSessionToken(session)}});
  expect(response.status).toBe(503);
  expect(getSessionWithUser(session)).toEqual(before);
  expect(gate.phase()).toBe('paused');
  const begin=vi.spyOn(gate,'beginWrite'),finish=vi.spyOn(gate,'finishWrite');
  try{
   const login=await app.request('/api/auth/login',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({username:id,password:'Synthetic-local-123456!'})});
   expect(login.status).toBe(200);
   expect(begin).toHaveBeenCalledTimes(1);
   expect(finish).toHaveBeenCalledWith(begin.mock.results[0].value);
  }finally{begin.mockRestore();finish.mockRestore();}
 }finally{closeDatabase();}
});

// This tests the HTTP ticket lifetime in the existing original-ready mode,
// not the complete host's restoration or its eligibility.
it('the original HTTP route runs under a write ticket once the gate is ready',async()=>{
 initDatabase();
 const gate=createAppointmentBootGate('original');
 const begin=vi.spyOn(gate,'beginWrite'),finish=vi.spyOn(gate,'finishWrite');
 const app=createAppForTest({appointmentBootGate:gate} as any);
 try{
  const response=await app.request('/api/auth/logout',{method:'POST'});
  expect(response.status).toBe(401);
  expect(begin).toHaveBeenCalledTimes(1);
  expect(finish).toHaveBeenCalledWith(begin.mock.results[0].value);
 }finally{begin.mockRestore();finish.mockRestore();closeDatabase();}
});
