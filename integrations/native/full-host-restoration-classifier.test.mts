import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {classifyRestorationRow,classifyRestorationResidue,isPassiveOriginalRunnerSnapshot} from './full-host-restoration-classifier.ts';
const classify=(table:string,row:Record<string,unknown>,extra:Record<string,unknown>={})=>classifyRestorationRow(table,row,{rows:new Map(),evidence:[],...extra});
test('passive audit/log facts are readable without inventing execution settlement',()=>{
 for(const table of ['task_run_logs','auth_audit_log','billing_audit_log','usage_records'])
  assert.equal(classify(table,{id:'retained',status:'unknown'}).disposition,'eligible');
});
test('terminal task labels do not settle retryable notifications',()=>{
 assert.equal(classify('task_runs',{id:'old',status:'success',notification_status:'failed'}).disposition,'blocked');
 assert.equal(classify('scheduled_tasks',{id:'old',status:'active'}).disposition,'blocked');
});
test('exact durable manual-review evidence stops a row without changing it',()=>{
 const row={id:'old',status:'running',result:'unknown'};const before=JSON.stringify(row);
 assert.equal(classify('task_runs',row,{preserved:{state:'manual_review_required',rowVersion:'row-hash',markerVersion:'marker-hash'}}).disposition,'stopped');
 assert.equal(JSON.stringify(row),before);
 assert.equal(classify('task_runs',row,{preserved:{state:'unverified',reason:'changed'}}).disposition,'blocked');
});
test('completed canonical result is independent from historic delivery certainty',()=>{
 assert.equal(classify('wecom_conversation_results',{receipt_id:'x'},{evidence:['d5_frozen_result_verified','result_delivery_unverified']}).disposition,'eligible');
 assert.equal(classify('wecom_conversation_results',{receipt_id:'x'},{evidence:['d5_result_relation_unverified']}).disposition,'blocked');
});
test('configuration is validated against concrete runtime capability and linked identity',()=>{
 const rows=new Map([['users',[{id:'owner'}]]]);
 const group={jid:'web:one',folder:'one',container_config:null,execution_mode:'container',created_by:'owner',target_agent_id:null,target_main_jid:null,channel_account_id:null};
 assert.equal(classify('registered_groups',group,{rows}).disposition,'eligible');
 for(const changed of [{execution_mode:'host'},{container_config:'{"additionalMounts":["/secret"]}'},{folder:'../escape'},{created_by:'unknown'}])
  assert.equal(classify('registered_groups',{...group,...changed},{rows}).disposition,'blocked');
});
test('directory enumeration is not proof that an executable file is settled',()=>{
 assert.equal(classifyRestorationResidue('residue/ipc/directory',['directory_observed']).disposition,'eligible');
 for(const kind of ['input','task','producer_marker','message_result','snapshot'])
  assert.equal(classifyRestorationResidue('residue/ipc/'+kind,['file_unsettled']).disposition,'blocked');
 assert.equal(classifyRestorationResidue('residue/ipc/snapshot',['filesystem_metadata_only','passive_original_runner_snapshot']).disposition,'eligible');
 assert.equal(classifyRestorationResidue('residue/ipc/input',['passive_original_runner_snapshot']).disposition,'blocked');
});
test('original normalized default profile is admissible but custom host/tool policy is not',()=>{
 const policy={reasoning:{effort:'inherit'},context:{source:'managed',auto_compact_window:0,auto_compact_percentage:0},skills:{mode:'inherit',ids:[]},mcp:{mode:'inherit',ids:[]}};
 const row={owner_user_id:'owner',status:'active',prompt_mode:'append',version:1,model_config_id:null,runtime_policy:JSON.stringify(policy)};
 const facts={rows:new Map([['users',[{id:'owner'}]]])};
 assert.equal(classify('agent_profiles',row,facts).disposition,'eligible');
 assert.equal(classify('agent_profiles',{...row,runtime_policy:JSON.stringify({...policy,context:{...policy.context,source:'host_claude'}})},facts).disposition,'blocked');
 assert.equal(classify('agent_profiles',{...row,runtime_policy:JSON.stringify({...policy,mcp:{mode:'custom',ids:['uninventoried']}})},facts).disposition,'blocked');
});
test('idle agents are executable recovery candidates, not passive history',()=>{
 const facts={rows:new Map([['registered_groups',[{folder:'one'}]]])};
 assert.equal(classify('agents',{group_folder:'one',status:'idle'},facts).disposition,'blocked');
 assert.equal(classify('agents',{group_folder:'one',status:'completed'},facts).disposition,'eligible');
});
test('D1 ready role binding must retain original owner and profile relationships',()=>{
 const claim={tenantId:'tenant',ownerId:'member',storeId:'store',role:'marketing',resourceKey:'',state:'ready',token:'token',profileId:'profile',workspaceJid:'web:role',corpId:'corp',botId:'bot',memberId:'external-member',bindingVersion:1,grantVersion:1};
 claim.resourceKey=createHash('sha256').update(JSON.stringify([claim.tenantId,claim.ownerId,claim.storeId,claim.role])).digest('hex');
 const rows=new Map<string,Record<string,unknown>[]>([
  ['users',[{id:'member',role:'member',status:'active',must_change_password:0}]],
  ['registered_groups',[{jid:'web:role',folder:'role',created_by:'member',is_home:0,execution_mode:'container'}]],
  ['agent_profiles',[{id:'profile',owner_user_id:'member',status:'active'}]],
  ['workspace_agent_profiles',[{group_folder:'role',agent_profile_id:'profile'}]],
 ]);
 const row={key:'wecom-role-workspace:v1:'+claim.resourceKey,value:JSON.stringify(claim)};
 assert.equal(classify('router_state',row,{rows}).disposition,'eligible');
 for(const change of [{ownerId:'another'},{state:'pending'},{resourceKey:'forged'},{profileId:'missing'}])
  assert.equal(classify('router_state',{...row,value:JSON.stringify({...claim,...change})},{rows}).disposition,'blocked');
});
test('only original information snapshot paths under a registered workspace are passive',()=>{
 const folders=new Set(['owned']);
 for(const name of ['current_tasks.json','available_groups.json'])
  assert.equal(isPassiveOriginalRunnerSnapshot('ipc/owned/'+name,'ipc/snapshot',folders),true);
 for(const name of ['ipc/other/current_tasks.json','ipc/owned/input/current_tasks.json','ipc/owned/.run-complete-attempt','config/owned/current_tasks.json','ipc/owned/control.json'])
  assert.equal(isPassiveOriginalRunnerSnapshot(name,'ipc/snapshot',folders),false);
 assert.equal(isPassiveOriginalRunnerSnapshot('ipc/owned/current_tasks.json','ipc/task',folders),false);
});
test('original admin default Home is inert under verified member-only execution fences',()=>{
 const group={jid:'web:main',folder:'main',is_home:1,created_by:'admin',execution_mode:'host',container_config:null,custom_cwd:null,init_source_path:null,init_git_url:null,target_agent_id:null,target_main_jid:null,channel_account_id:null,selected_skills:null,selected_mcps:null,mcp_mode:'inherit'};
 const rows=new Map<string,Record<string,unknown>[]>([
  ['users',[{id:'admin',role:'admin',status:'active'}]],
  ['registered_groups',[group]],
  ['workspaces',[{jid:'web:main',folder:'main',owner_user_id:'admin',is_home:1,status:'active'}]],
  ['agent_profiles',[{id:'default',owner_user_id:'admin',is_default:1,status:'active'}]],
  ['workspace_agent_profiles',[{group_folder:'main',agent_profile_id:'default'}]],
 ]);
 assert.equal(classify('registered_groups',group,{rows}).disposition,'eligible');
 for(const change of [{is_home:0},{created_by:'member'},{jid:'web:arbitrary'},{folder:'unrelated'},{custom_cwd:'/outside'},{target_agent_id:'other'},{init_git_url:'https://invalid.example/project'},{selected_skills:'["custom"]'}])
  assert.equal(classify('registered_groups',{...group,...change},{rows}).disposition,'blocked');
 rows.set('users',[{id:'admin',role:'member',status:'active'}]);
 assert.equal(classify('registered_groups',group,{rows}).disposition,'blocked');
});
test('untouched original Home introduction remains pending without inventing completion or a runner',()=>{
 const row={workspace_jid:'web:home-member',flow_key:'miniclaw.owner-introduction',state:'pending',revision:0,lease_token:0,lease_owner:null,lease_expires_at:null,first_wake_at:null,completed_at:null,skipped_at:null};
 const rows=new Map([['workspaces',[{jid:row.workspace_jid,is_home:1,status:'active'}]]]);
 const before=JSON.stringify(row);
 assert.equal(classify('workspace_onboarding_states',row,{rows}).disposition,'eligible');
 assert.equal(JSON.stringify(row),before);
 for(const change of [{state:'claimed'},{state:'completed'},{state:'unknown'},{revision:1},{lease_token:1},{lease_owner:'old-runner'},{first_wake_at:'2026-10-23T00:00:00Z'},{flow_key:'other'},{workspace_jid:'missing'}])
  assert.equal(classify('workspace_onboarding_states',{...row,...change},{rows}).disposition,'blocked');
 rows.set('workspaces',[{jid:row.workspace_jid,is_home:0,status:'active'}]);
 assert.equal(classify('workspace_onboarding_states',row,{rows}).disposition,'blocked');
});
test('memory store identity and revision are passive resources while memory execution stores remain unsupported',()=>{
 const rows=new Map([['workspaces',[{jid:'web:owned'}]]]);
 for(const revision of [0,2])assert.equal(classify('workspace_memory_stores',{id:'wms_synthetic',workspace_jid:'web:owned',revision},{rows}).disposition,'eligible');
 for(const changed of [{revision:-1},{revision:0.5},{workspace_jid:'missing'},{id:''}])
  assert.equal(classify('workspace_memory_stores',{id:'wms_synthetic',workspace_jid:'web:owned',revision:0,...changed},{rows}).disposition,'blocked');
 assert.equal(classify('workspace_memory_outbox',{id:'unknown',workspace_jid:'web:owned',state:'pending'},{rows}).disposition,'blocked');
});
