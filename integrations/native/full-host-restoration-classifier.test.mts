import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {classifyRestorationRow,classifyRestorationResidue,isPassiveOriginalRunnerSnapshot} from './full-host-restoration-classifier.ts';
const classify=(table:string,row:Record<string,unknown>,extra:Record<string,unknown>={})=>classifyRestorationRow(table,row,{rows:new Map(),evidence:[],...extra});
function cancelledFacts(active:boolean){
 const digest=(value:unknown)=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
 const actor={tenantId:'tenant',accountId:'owner',storeId:'store',corpId:'corp',botId:'bot',memberId:'member',bindingVersion:1,grantVersion:1};
 const message={id:'input',chat_jid:'web:owned',source_jid:'web:owned',sender:'owner',timestamp:'synthetic-time',content:'synthetic request',is_from_me:0,delivery_status:null};
 const receipt={receipt_id:digest(['corp','bot','member','origin']),message_id:'input',workspace_jid:'web:owned',accepted_at:'synthetic-time',origin_message_id:'origin',text_hash:digest(message.content),actor_json:JSON.stringify(actor)};
 const execution={receipt_id:receipt.receipt_id,message_id:'input',workspace_jid:'web:owned',state:'cancelled',query_id:active?'query':null,turn_id:active?'input':null,input_json:active?'["input"]':null,batch_size:active?1:null,session_id:null};
 const rows=new Map<string,Record<string,unknown>[]>([['messages',[message]],['wecom_conversation_receipts',[receipt]],['wecom_conversation_execution',[execution]],['wecom_conversation_results',[]]]);
 return {rows,message,receipt,execution};
}
for(const active of [false,true])test('exact D3 cancelled '+(active?'active':'queued')+' input is terminal without replay',()=>{
 const f=cancelledFacts(active);
 for(const [table,row] of [['messages',f.message],['wecom_conversation_receipts',f.receipt],['wecom_conversation_execution',f.execution]] as const)
  assert.equal(classify(table,row,{rows:f.rows}).disposition,'terminal');
});
test('cancelled label without exact original input relations stays blocked',()=>{
 const mutations=[
  (f:ReturnType<typeof cancelledFacts>)=>f.rows.set('wecom_conversation_receipts',[]),
  (f:ReturnType<typeof cancelledFacts>)=>f.rows.set('messages',[]),
  (f:ReturnType<typeof cancelledFacts>)=>{f.execution.workspace_jid='web:foreign';},
  (f:ReturnType<typeof cancelledFacts>)=>{f.message.source_jid='web:foreign';},
  (f:ReturnType<typeof cancelledFacts>)=>{f.receipt.actor_json='{}';},
  (f:ReturnType<typeof cancelledFacts>)=>{f.receipt.text_hash='forged';},
  (f:ReturnType<typeof cancelledFacts>)=>{f.receipt.origin_message_id='forged';},
  (f:ReturnType<typeof cancelledFacts>)=>{f.execution.state='unknown';},
  (f:ReturnType<typeof cancelledFacts>)=>{f.execution.state='cancelling';},
  (f:ReturnType<typeof cancelledFacts>)=>{f.execution.input_json='["foreign"]';},
  (f:ReturnType<typeof cancelledFacts>)=>{f.execution.batch_size=2;},
  (f:ReturnType<typeof cancelledFacts>)=>f.rows.set('wecom_conversation_results',[{receipt_id:f.receipt.receipt_id}]),
  (f:ReturnType<typeof cancelledFacts>)=>f.rows.get('messages')!.push({id:'output',chat_jid:'web:owned',is_from_me:1,turn_id:'input'}),
 ];
 for(const mutate of mutations){const f=cancelledFacts(true);mutate(f);assert.equal(classify('wecom_conversation_execution',f.execution,{rows:f.rows}).disposition,'blocked');}
 const queued=cancelledFacts(false);queued.execution.turn_id='input';assert.equal(classify('wecom_conversation_execution',queued.execution,{rows:queued.rows}).disposition,'blocked');
 const preserved=cancelledFacts(true);
 assert.equal(classify('wecom_conversation_execution',preserved.execution,{rows:preserved.rows,preserved:{state:'manual_review_required',rowVersion:'original',markerVersion:'marker'}}).disposition,'stopped');
 assert.equal(classify('wecom_conversation_execution',preserved.execution,{rows:preserved.rows,preserved:{state:'changed'}}).disposition,'blocked');
});
test('queued cancellation with an impossible canonical output remains unresolved',()=>{
 const f=cancelledFacts(false);
 f.rows.get('messages')!.push({id:'impossible-output',chat_jid:'web:owned',is_from_me:1,turn_id:'input',delivery_status:null});
 for(const [table,row] of [['messages',f.message],['wecom_conversation_receipts',f.receipt],['wecom_conversation_execution',f.execution]] as const)
  assert.equal(classify(table,row,{rows:f.rows}).disposition,'blocked');
});
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
test('only explicitly verified original configuration is eligible',()=>{
 for(const reason of ['original_loaded_session_secret','original_disabled_plugin_autoscan']){
  assert.equal(classifyRestorationResidue('residue/config/opaque',['verified_existing_config:'+reason]).disposition,'eligible');
  assert.equal(classifyRestorationResidue('residue/ipc/input',['verified_existing_config:'+reason]).disposition,'blocked');
 }
 assert.equal(classifyRestorationResidue('residue/config/opaque',['verified_existing_config:unknown']).disposition,'blocked');
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
test('existing custom role stays static and requires verified local capability context',()=>{
 const policy={reasoning:{effort:'low'},context:{source:'managed',auto_compact_window:0,auto_compact_percentage:0},skills:{mode:'custom',ids:['beauty-local-content']},mcp:{mode:'disabled',ids:[]}};
 const row={owner_user_id:'owner',status:'active',prompt_mode:'append',version:1,model_config_id:null,runtime_policy:JSON.stringify(policy)};
 const facts={rows:new Map([['users',[{id:'owner'}]]]),evidence:['existing_profile_context_verified']};
 assert.equal(classify('agent_profiles',row,facts).disposition,'eligible');
 assert.equal(classify('agent_profiles',row,{...facts,evidence:[]}).disposition,'blocked');
 for(const change of [{context:{...policy.context,source:'host_claude'}},{skills:{mode:'custom',ids:['../escape']}},{mcp:{mode:'custom',ids:['server']}},{skills:{mode:'custom',ids:['same','same']}}])
  assert.equal(classify('agent_profiles',{...row,runtime_policy:JSON.stringify({...policy,...change})},facts).disposition,'blocked');
});

test('original normalized disabled host skills remain static without enabling host capability',()=>{
 const policy={reasoning:{effort:'low'},context:{source:'managed',auto_compact_window:0,auto_compact_percentage:0},skills:{mode:'custom',ids:['beauty-local-content'],host:{mode:'disabled',ids:[]}},mcp:{mode:'disabled',ids:[]}};
 const row={owner_user_id:'owner',status:'active',prompt_mode:'append',version:1,model_config_id:null,runtime_policy:JSON.stringify(policy)};
 const facts={rows:new Map([['users',[{id:'owner'}]]]),evidence:['existing_profile_context_verified']};
 assert.equal(classify('agent_profiles',row,facts).disposition,'eligible');
 assert.equal(classify('agent_profiles',row,{...facts,evidence:[]}).disposition,'blocked');
 for(const host of [{mode:'inherit',ids:[]},{mode:'custom',ids:[]},{mode:'disabled',ids:['skill']},{mode:'disabled',ids:[],extra:true},JSON.stringify({mode:'disabled',ids:[]}),null])
  assert.equal(classify('agent_profiles',{...row,runtime_policy:JSON.stringify({...policy,skills:{...policy.skills,host}})},facts).disposition,'blocked');
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
test('original memory item is retained only when its workspace, store and current version agree',()=>{
 const item={id:'item',store_id:'store',workspace_jid:'web:owned',kind:'fact',status:'active',revision:1,content:'retained',title:'title',canonical_key:null,importance:0.5,confidence:0.9,valid_from:null,valid_until:null,expires_at:null};
 const rows=new Map<string,Record<string,unknown>[]>([
  ['workspaces',[{jid:'web:owned'}]],['workspace_memory_stores',[{id:'store',workspace_jid:'web:owned',revision:1}]],
  ['workspace_memory_versions',[{...item,item_id:'item'}]],
 ]);
 const before=JSON.stringify(item);assert.equal(classify('workspace_memory_items',item,{rows}).disposition,'eligible');assert.equal(JSON.stringify(item),before);
 for(const changed of [{store_id:'other'},{workspace_jid:'web:other'},{revision:0},{status:'unknown'},{kind:'unknown'},{content:'different'},{title:'changed'},{confidence:0.3},{expires_at:'2020-01-01'}])
  assert.equal(classify('workspace_memory_items',{...item,...changed},{rows}).disposition,'blocked');
 rows.set('workspace_memory_stores',[{id:'store',workspace_jid:'web:owned',revision:0}]);assert.equal(classify('workspace_memory_items',item,{rows}).disposition,'blocked');
 rows.set('workspace_memory_stores',[{id:'store',workspace_jid:'web:owned',revision:1}]);
 rows.set('workspace_memory_stores',[{workspace_jid:'web:owned',revision:1}]);assert.equal(classify('workspace_memory_items',{...item,store_id:undefined},{rows}).disposition,'blocked');
 rows.set('workspace_memory_stores',[{id:'store',workspace_jid:'web:owned',revision:1}]);
 rows.set('workspace_memory_versions',[]);assert.equal(classify('workspace_memory_items',item,{rows}).disposition,'blocked');
 assert.equal(classify('workspace_memory_outbox',{id:'unknown',status:'pending'},{rows}).disposition,'blocked');
});
test('untouched original memory event stays pending only in verified local no-consumer scope',()=>{
 const item={id:'item',store_id:'store',workspace_jid:'web:owned',kind:'fact',status:'active',revision:1,content:'retained',created_at:'2026-10-30T00:00:00Z'};
 const payload={workspaceJid:'web:owned',storeRevision:1,itemId:'item',itemRevision:1,status:'active'};
 const row={id:'event',workspace_jid:'web:owned',store_id:'store',item_id:'item',item_revision:1,event_type:'memory.created',status:'pending',attempt:0,available_at:null,error:null,delivered_at:null,created_at:'2026-10-30T00:00:00Z',updated_at:'2026-10-30T00:00:00Z',payload_json:JSON.stringify(payload)};
 const rows=new Map<string,Record<string,unknown>[]>([['workspaces',[{jid:'web:owned'}]],['workspace_memory_stores',[{id:'store',workspace_jid:'web:owned',revision:1}]],['workspace_memory_items',[item]],['workspace_memory_versions',[{...item,item_id:'item',change_type:'create'}]],['workspace_memory_audit_events',[{workspace_jid:'web:owned',store_id:'store',item_id:'item',item_revision:1,store_revision:1,action:'create',created_at:row.created_at}]]]);
 const facts={rows,evidence:['existing_memory_event_no_consumer']},before=JSON.stringify(row);
 assert.equal(classify('workspace_memory_outbox',row,facts).disposition,'stopped');assert.equal(JSON.stringify(row),before);
 assert.equal(classify('workspace_memory_outbox',row,{rows,evidence:[]}).disposition,'blocked');
 for(const change of [{status:'processing'},{attempt:1},{event_type:'unknown'},{delivered_at:row.created_at},{payload_json:JSON.stringify({...payload,itemId:'other'})},{store_id:'other'}])assert.equal(classify('workspace_memory_outbox',{...row,...change},facts).disposition,'blocked');
 rows.set('workspace_memory_audit_events',[{workspace_jid:'web:owned',store_id:'store',item_id:'item',item_revision:1,store_revision:999,action:'create',created_at:row.created_at}]);
 assert.equal(classify('workspace_memory_outbox',{...row,payload_json:JSON.stringify({...payload,storeRevision:999})},facts).disposition,'blocked');
 rows.set('workspace_memory_audit_events',[{workspace_jid:'web:owned',store_id:'store',item_id:'item',item_revision:1,store_revision:1,action:'create',created_at:row.created_at}]);
 rows.set('workspace_memory_versions',[{...item,item_id:'item',change_type:'update'}]);assert.equal(classify('workspace_memory_outbox',row,facts).disposition,'blocked');
 rows.set('workspace_memory_audit_events',[]);assert.equal(classify('workspace_memory_outbox',row,facts).disposition,'blocked');
});
