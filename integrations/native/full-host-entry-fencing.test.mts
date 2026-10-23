import {afterAll,expect,it,vi} from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
const isolated=await vi.hoisted(async()=>{
 const fs=await import('node:fs'),os=await import('node:os'),path=await import('node:path');
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'qiwe-entry-fence-'));
 return {root,data:path.join(root,'data'),store:path.join(root,'data/db')};
});
vi.mock('../src/config.js',async original=>({...await original<any>(),DATA_DIR:isolated.data,STORE_DIR:isolated.store}));
import {initDatabase,closeDatabase,createUser,createUserSession,getSessionWithUser} from '../src/db.js';
import {createAppointmentBootGate} from '../src/appointment-boot-gate.js';
import {createAppForTest} from '../src/web.js';
import {hashPassword,signSessionToken} from '../src/auth.js';

afterAll(()=>{if(path.dirname(fs.realpathSync(isolated.root))!==fs.realpathSync(os.tmpdir()))throw Error('UNSAFE_TEST_CLEANUP');fs.rmSync(isolated.root,{recursive:true,force:true});});

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
