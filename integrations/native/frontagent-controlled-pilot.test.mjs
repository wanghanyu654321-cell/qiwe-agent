import test from 'node:test';
import assert from 'node:assert/strict';
import {prepareExistingFrontagentPilot} from './frontagent-controlled-pilot.mjs';

function fixture(){
 const descriptor={accountId:'member',tenantId:'tenant',storeId:'store-b',homeJid:'web:home',workspaceJid:'web:marketing',folder:'marketing-folder',profileId:'profile',employee:{employeeId:'employee',employeeName:'test'}};
 const binding={active:true,accountId:'member',botId:'bot',corpId:'corp',memberId:'member-channel',version:3};
 const grant={active:true,storeId:'store-b',roles:['marketing'],version:2};
 const approved={...binding,tenantId:'tenant',storeId:'store-b',role:'marketing',profileId:'profile',workspaceJid:'web:marketing'};
 const actor={tenantId:'tenant',accountId:'member',storeId:'store-b',grantVersion:2,botId:'bot',corpId:'corp',memberId:'member-channel',bindingVersion:3};
 const events=[],issued={identity:{tenantId:'tenant',accountId:'member',storeId:'store-b',grantVersion:2},channel:{botId:'bot',corpId:'corp',memberId:'member-channel',bindingVersion:3}};
 const state={phase:'ready',binding,grant,approved,credentials:{botId:'bot',corpId:'corp',secret:'private'},prepareFailure:false,closeStatus:'closed'};
 const gate={phase:()=>state.phase,isPaused:()=>state.phase!=='ready',beginWrite:()=>({id:'ticket'}),finishWrite(){}};
 const db={getUserById:()=>({id:'member',role:'member',status:'active',must_change_password:false}),getGroupsByOwner:()=>[{jid:'web:home',is_home:true,created_by:'member',executionMode:'container'}],getRegisteredGroup:()=>({jid:'web:marketing',folder:'marketing-folder',created_by:'member',is_home:false,executionMode:'container'}),getWorkspaceAgentProfileId:()=> 'profile',getAgentProfileForUser:()=>({id:'profile',owner_user_id:'member',status:'active'})};
 let captured;const authority={authorize:async()=>issued,assertCurrent:async()=>{},withCurrent:work=>work(),close:()=>events.push('authority-close')};
 const modules={createWecomBotBindingReader:read=>async()=>{const rows=await read();return rows[0]},createControlledRealWecomBotContext:()=>authority,
  createExistingRoleWorkspaceAdopter:()=>({adopt:async()=>{events.push('adopt');return {state:'ready',workspaceJid:'web:marketing',profileId:'profile'}}}),
  createControlledRealBotConversationNativePort:options=>({options}),createControlledRealRoleWorkspaceNativePort:options=>({readRoleWorkspace(){},options}),
  createControlledRealWecomBotPilot:options=>{captured=options;events.push('factory');return {prepare:async()=>{events.push('prepare');if(state.prepareFailure)throw Error('original-error');return 'prepared'},activate:()=>{events.push('activate');return true},close:async()=>{events.push('pilot-close')},status:()=>state.closeStatus,idle:async()=>{}}}};
 const options={descriptor,gate,db,host:{fullHostBootGate:gate,fullHostQueue:{},initializeControlledRealFullHostConversationExecution(){return {gate,queue:this.fullHostQueue}}},
  grants:{get:()=>state.grant},ledger:{},tasks:{},readBindings:()=>[state.binding],readApproved:()=>[state.approved],readCredentials:()=>state.credentials,
  runId:'trial',expiresAt:Date.now()+60000,journalDirectory:'/tmp/unused',modules};
 return {options,state,events,actor,get captured(){return captured}};
}
test('restored original host adopts the existing role before preparing the real factory; activation is explicit',async()=>{
 const f=fixture(),pilot=await prepareExistingFrontagentPilot(f.options);
 assert.deepEqual(f.events,['adopt','factory','prepare']);assert.equal(f.captured.mode,'controlled-real-pilot');
 assert.deepEqual(f.captured.business.employees,[{accountId:'member',employeeId:'employee',employeeName:'test'}]);
 assert.equal(f.captured.authorize({actor:f.actor,role:'marketing'}),true);
 assert.equal(pilot.activate(),true);await pilot.close();assert.deepEqual(f.events,['adopt','factory','prepare','activate','pilot-close','authority-close']);
});
test('does not prepare real channel while paused, with missing mappings, revoked authority, or wrong original resources',async()=>{
 for(const change of [f=>f.state.phase='paused',f=>f.state.binding.active=false,f=>f.state.grant.active=false,f=>f.state.approved.workspaceJid='web:foreign',f=>f.state.credentials.botId='other',f=>f.options.db.getRegisteredGroup=()=>null]){
  const f=fixture();change(f);await assert.rejects(()=>prepareExistingFrontagentPilot(f.options));assert.equal(f.events.includes('factory'),false);
 }
});
test('revoked grant, changed binding, changed approval and changed owner fail future authorization',async()=>{
 for(const change of [f=>f.state.grant.active=false,f=>f.state.binding.version++,f=>f.state.approved.profileId='other',f=>f.options.db.getUserById=()=>null]){
  const f=fixture(),pilot=await prepareExistingFrontagentPilot(f.options);change(f);assert.equal(f.captured.authorize({actor:f.actor,role:'marketing'}),false);await pilot.close();
 }
});
test('never allows role creation or replacement of the original queue',async()=>{
 const f=fixture();f.options.host.initializeControlledRealFullHostConversationExecution=()=>({gate:f.options.gate,queue:{}});
 const pilot=await prepareExistingFrontagentPilot(f.options);const roles=f.captured.createRoles(f.options.gate);
 await assert.rejects(()=>roles.prepareRoleWorkspace(),/FORBIDDEN/);
 assert.throws(()=>f.captured.initializeExecution({mode:'controlled-real-pilot',authorize:()=>true,onCompleted(){}}),/HOST_EXECUTION/);
 await pilot.close();
});
test('employee metadata cannot replace the trusted existing account',async()=>{
 const f=fixture();f.options.descriptor.employee.accountId='foreign';const pilot=await prepareExistingFrontagentPilot(f.options);
 assert.equal(f.captured.business.employees[0].accountId,'member');await pilot.close();
});
test('prepare failure cannot hide uncertain underlying bot cleanup',async()=>{
 const f=fixture();f.state.prepareFailure=true;f.state.closeStatus='cleanup_unknown';
 await assert.rejects(()=>prepareExistingFrontagentPilot(f.options),error=>error.message==='FRONTAGENT_PILOT_CLEANUP_UNKNOWN'&&error.originalError?.message==='original-error');
 assert.deepEqual(f.events,['adopt','factory','prepare','pilot-close','authority-close']);
});
test('prepare failure preserves the original error when underlying close is confirmed',async()=>{
 const f=fixture();f.state.prepareFailure=true;
 await assert.rejects(()=>prepareExistingFrontagentPilot(f.options),/original-error/);assert.equal(f.events.at(-1),'authority-close');
});
