import {createHash} from 'node:crypto';
/** The bounded inventory owns all reads. This module neither starts work nor
 * changes retained rows. A valid passive fact is not an execution receipt. */
export type RestorationRow = Record<string, unknown>;
export type RestorationDecision = { disposition: 'eligible'|'terminal'|'stopped'|'blocked'; evidence: string[] };
export type RestorationFacts = {
  rows: ReadonlyMap<string, readonly RestorationRow[]>;
  preserved?: {state:string; rowVersion?:string; markerVersion?:string} | undefined;
  evidence: readonly string[];
};
const decision=(disposition:RestorationDecision['disposition'],evidence:string):RestorationDecision=>({disposition,evidence:[evidence]});
const closed=()=>decision('blocked','unsupported_legacy_state');
const text=(value:unknown):value is string=>typeof value==='string'&&value.length>0;
const oneOf=(value:unknown,values:readonly unknown[])=>values.includes(value);
const integer=(value:unknown)=>typeof value==='number'&&Number.isSafeInteger(value)&&value>=0;
const object=(value:unknown):Record<string,unknown>|undefined=>{
 try{const parsed=typeof value==='string'?JSON.parse(value):value;return parsed&&typeof parsed==='object'&&!Array.isArray(parsed)?parsed:undefined;}catch{return undefined;}
};
const array=(value:unknown)=>{try{const parsed=typeof value==='string'?JSON.parse(value):value;return Array.isArray(parsed)?parsed:undefined;}catch{return undefined;}};
// db.ts DEFAULT_AGENT_PROFILE_RUNTIME_POLICY and normalize... (7933–8050).
// Custom skill/MCP/host policy requires a wider capability inventory.
const defaultPolicy=(value:unknown)=>{
 const policy=object(value);if(!policy)return false;if(Object.keys(policy).length===0)return true;
 const reasoning=object(policy.reasoning),context=object(policy.context),skills=object(policy.skills),mcp=object(policy.mcp);
 return Object.keys(policy).sort().join(',')==='context,mcp,reasoning,skills'&&
  reasoning&&Object.keys(reasoning).join(',')==='effort'&&reasoning.effort==='inherit'&&
  context&&Object.keys(context).sort().join(',')==='auto_compact_percentage,auto_compact_window,source'&&context.source==='managed'&&context.auto_compact_window===0&&context.auto_compact_percentage===0&&
  [skills,mcp].every(section=>section&&Object.keys(section).sort().join(',')==='ids,mode'&&section.mode==='inherit'&&Array.isArray(section.ids)&&section.ids.length===0);
};

export function classifyRestorationRow(table:string,row:RestorationRow,facts:RestorationFacts):RestorationDecision {
 const all=(name:string)=>facts.rows.get(name)??[];
 const linked=(name:string,column:string,value:unknown)=>text(value)&&all(name).some(item=>item[column]===value);
 const optionalLink=(name:string,column:string,value:unknown)=>value===null||value===''||linked(name,column,value);
 const passive=()=>decision('eligible','passive_fact_no_replay_consumer');
 const resource=()=>decision('eligible','supported_original_resource_contract');
 // D3's queued cancellation never claims a query; active cancellation only
 // becomes terminal after the matching runner interruption. Validate the
 // persisted producer relationships, not the word "cancelled" alone. This
 // establishes no automatic replay, not absence of earlier tool side effects.
 const cancelled=(execution:RestorationRow|undefined):boolean=>{
  if(!execution||execution.state!=='cancelled'||!text(execution.message_id)||!text(execution.workspace_jid))return false;
  const receipt=all('wecom_conversation_receipts').find(item=>item.receipt_id===execution.receipt_id);
  if(!receipt||receipt.workspace_jid!==execution.workspace_jid||receipt.message_id!==execution.message_id)return false;
  const actor=object(receipt.actor_json),message=all('messages').find(item=>item.id===receipt.message_id&&item.chat_jid===receipt.workspace_jid);
  const digest=(value:unknown)=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
  if(!actor||!['tenantId','accountId','storeId','corpId','botId','memberId'].every(key=>text(actor[key]))||
    !integer(actor.bindingVersion)||Number(actor.bindingVersion)<1||!integer(actor.grantVersion)||Number(actor.grantVersion)<1||
    !text(receipt.origin_message_id)||receipt.receipt_id!==digest([actor.corpId,actor.botId,actor.memberId,receipt.origin_message_id])||
    !message||message.is_from_me!==0||message.source_jid!==receipt.workspace_jid||message.sender!==actor.accountId||
    message.timestamp!==receipt.accepted_at||typeof message.content!=='string'||receipt.text_hash!==digest(message.content)||
    all('wecom_conversation_results').some(item=>item.receipt_id===receipt.receipt_id))return false;
  if(execution.query_id===null)return ['turn_id','input_json','batch_size','session_id'].every(key=>execution[key]===null)&&
   !all('messages').some(item=>item.chat_jid===execution.workspace_jid&&item.turn_id===execution.message_id&&item.is_from_me===1);
  const inputs=array(execution.input_json);
  if(!text(execution.query_id)||!text(execution.turn_id)||!inputs?.length||!inputs.every(text)||new Set(inputs).size!==inputs.length||
    execution.batch_size!==inputs.length||!inputs.includes(execution.message_id)||!inputs.includes(execution.turn_id))return false;
  if(all('messages').some(item=>item.chat_jid===execution.workspace_jid&&item.turn_id===execution.turn_id&&item.is_from_me===1))return false;
  return inputs.every(id=>all('wecom_conversation_execution').some(item=>item.workspace_jid===execution.workspace_jid&&item.message_id===id&&
    item.query_id===execution.query_id&&item.turn_id===execution.turn_id&&item.state==='cancelled'&&item.input_json===execution.input_json&&item.batch_size===execution.batch_size))&&
   all('wecom_conversation_execution').filter(item=>item.workspace_jid===execution.workspace_jid&&item.query_id===execution.query_id)
    .every(item=>item.state==='cancelled'&&text(item.message_id)&&inputs.includes(item.message_id)&&item.turn_id===execution.turn_id&&item.input_json===execution.input_json&&item.batch_size===execution.batch_size);
 };
 const cancelledFact=()=>decision('terminal','exact_d3_cancelled_input_no_replay');
 if(facts.preserved){
  if(facts.preserved.state==='manual_review_required'&&text(facts.preserved.rowVersion)&&text(facts.preserved.markerVersion))
   return decision('stopped','exact_durable_manual_review:'+facts.preserved.markerVersion);
  return decision('blocked','preserved_row_changed_or_invalid');
 }
 switch(table){
  // These stores have no scheduler, runner or sender consuming their historical
  // rows. Ordinary future authorized reads/edits are not replay of old work.
  case 'auth_audit_log':case 'billing_audit_log':case 'task_run_logs':
  case 'usage_events':case 'usage_records':case 'usage_daily_summary':case 'monthly_usage':case 'daily_usage':
  case 'balance_transactions':case 'redeem_code_usage':
  case 'agent_profile_prompt_versions':case 'workspace_memory_versions':case 'workspace_memory_provenance':
  case 'workspace_memory_tombstones':case 'workspace_memory_audit_events':case 'workspace_memory_mutation_requests':return passive();
  case 'chats':return resource();
  case 'users':return oneOf(row.role,['admin','member'])&&oneOf(row.status,['active','disabled','deleted'])&&
   array(row.permissions)?.every(text)&&oneOf(row.must_change_password,[0,1])?resource():closed();
  case 'user_sessions':return linked('users','id',row.user_id)&&text(row.expires_at)&&Number.isFinite(Date.parse(row.expires_at))?resource():closed();
  case 'billing_plans':return integer(row.tier)&&oneOf(row.is_active,[0,1])&&oneOf(row.is_default,[0,1])&&oneOf(row.allow_overage,[0,1])?resource():closed();
  case 'user_balances':case 'user_quotas':return linked('users','id',row.user_id)?resource():closed();
  case 'user_subscriptions':return linked('users','id',row.user_id)&&linked('billing_plans','id',row.plan_id)&&oneOf(row.status,['active','expired','cancelled'])?resource():closed();
  case 'invite_codes':case 'redeem_codes':return integer(row.max_uses)&&integer(row.used_count)?resource():closed();
  case 'user_pinned_groups':return linked('users','id',row.user_id)&&linked('registered_groups','jid',row.jid)?resource():closed();
  case 'registered_groups': {
   const config=row.container_config===null?{}:object(row.container_config);
   // ensureUserHomeGroup produces these two identities. The composed scanner
   // requires member-only policy plus the physical host/script/inline fences;
   // an admin Home remains a configuration fact, not an enabled host runner.
   const owner=all('users').find(item=>item.id===row.created_by);
   const defaultHome=row.execution_mode==='host'&&row.is_home===1&&owner?.role==='admin'&&owner.status==='active'&&
    ((row.jid==='web:main'&&row.folder==='main')||(row.jid==='web:home-'+row.created_by&&row.folder==='home-'+row.created_by))&&
    ['custom_cwd','init_source_path','init_git_url','target_agent_id','target_main_jid','channel_account_id','selected_skills','selected_mcps'].every(key=>row[key]===null)&&row.mcp_mode==='inherit'&&
    all('workspaces').some(item=>item.jid===row.jid&&item.folder===row.folder&&item.owner_user_id===row.created_by&&item.is_home===1&&item.status==='active')&&
    all('agent_profiles').some(profile=>profile.owner_user_id===row.created_by&&profile.is_default===1&&profile.status==='active'&&
     all('workspace_agent_profiles').some(binding=>binding.group_folder===row.folder&&binding.agent_profile_id===profile.id));
   // Extra mounts and other host configurations remain unsupported.
   return text(row.folder)&&!row.folder.includes('/')&&!row.folder.includes('\\')&&row.folder!=='.'&&row.folder!=='..'&&
    config&&Object.keys(config).length===0&&(row.execution_mode==='container'||defaultHome)&&
    optionalLink('users','id',row.created_by)&&optionalLink('agents','id',row.target_agent_id)&&
    optionalLink('registered_groups','jid',row.target_main_jid)&&optionalLink('channel_accounts','id',row.channel_account_id)?resource():closed();
  }
  case 'workspaces':return oneOf(row.status,['active','archived'])&&linked('registered_groups','jid',row.jid)&&optionalLink('users','id',row.owner_user_id)?resource():closed();
  // memory-store.ts creates one identity/revision container per workspace.
  // Memory items and outbox rows are classified independently; this row does
  // not schedule their execution or claim that their contents are verified.
  case 'workspace_memory_stores':return text(row.id)&&linked('workspaces','jid',row.workspace_jid)&&integer(row.revision)?resource():closed();
  // The owner-profile schema creates this untouched initial Home state. Claim
  // happens only through an authenticated live owner-turn IPC request, not a
  // pending-row startup scan. Previously claimed/released states stay closed.
  case 'workspace_onboarding_states':return row.flow_key==='miniclaw.owner-introduction'&&row.state==='pending'&&
   row.revision===0&&row.lease_token===0&&['lease_owner','lease_expires_at','first_wake_at','completed_at','skipped_at'].every(key=>row[key]===null)&&
   all('workspaces').some(item=>item.jid===row.workspace_jid&&item.is_home===1&&item.status==='active')?
   decision('eligible','original_initial_onboarding_no_prior_claim'):closed();
  case 'agent_profiles':return linked('users','id',row.owner_user_id)&&oneOf(row.status,['active','archived'])&&oneOf(row.prompt_mode,['append','replace'])&&
   integer(row.version)&&(row.version as number)>0&&defaultPolicy(row.runtime_policy)&&row.model_config_id===null?resource():closed();
  case 'workspace_agent_profiles':return linked('registered_groups','folder',row.group_folder)&&linked('agent_profiles','id',row.agent_profile_id)&&oneOf(row.interaction_mode,['assistant','proactive'])?resource():closed();
  case 'sessions':case 'workspace_runtime_sessions':return linked('registered_groups','folder',row.group_folder)&&
   optionalLink('agent_profiles','id',row.agent_profile_id)&&typeof (table==='sessions'?row.session_id:row.sdk_session_id)==='string'?passive():closed();
  case 'agents':return linked('registered_groups','folder',row.group_folder)&&oneOf(row.status,['completed','error'])?passive():closed();
  case 'router_state': {
   if(row.key==='schema_version')return row.value==='73'?resource():closed();
   // D1 producer/consumer: role-workspace-overlay.mjs addOwnedWorkspaceClaims
   // and createRoleWorkspaceNativePort.read. A ready claim is a durable binding,
   // never a queued creation attempt; pending owner claims remain unsupported.
   if(typeof row.key==='string'&&row.key.startsWith('wecom-role-workspace:v1:')){
    const claim=object(row.value);if(!claim)return closed();
    const fields=['tenantId','ownerId','storeId','role','resourceKey','state','token','profileId','workspaceJid','corpId','botId','memberId','bindingVersion','grantVersion'];
    if(Object.keys(claim).sort().join(',')!==fields.sort().join(',')||claim.state!=='ready'||
      !['tenantId','ownerId','storeId','role','token','profileId','workspaceJid','corpId','botId','memberId'].every(key=>text(claim[key]))||
      !integer(claim.bindingVersion)||Number(claim.bindingVersion)<1||!integer(claim.grantVersion)||Number(claim.grantVersion)<1)return closed();
    const key=createHash('sha256').update(JSON.stringify([claim.tenantId,claim.ownerId,claim.storeId,claim.role])).digest('hex');
    const group=all('registered_groups').find(item=>item.jid===claim.workspaceJid);
    const profile=all('agent_profiles').find(item=>item.id===claim.profileId);
    const owner=all('users').find(item=>item.id===claim.ownerId);
    return claim.resourceKey===key&&row.key==='wecom-role-workspace:v1:'+key&&
      /^web:(?!home(?:-|:|$))[^\s#]{1,196}$/.test(String(claim.workspaceJid))&&
      owner?.role==='member'&&owner.status==='active'&&owner.must_change_password===0&&
      group&&group.created_by===claim.ownerId&&group.is_home===0&&group.execution_mode==='container'&&
      profile&&profile.owner_user_id===claim.ownerId&&profile.status==='active'&&
      all('workspace_agent_profiles').some(item=>item.group_folder===group.folder&&item.agent_profile_id===claim.profileId)?resource():closed();
   }
   if(row.key==='last_timestamp'||row.key==='last_timestamp_id')return typeof row.value==='string'?resource():closed();
   if(row.key==='last_agent_timestamp'||row.key==='last_committed_cursor'){
    const cursors=object(row.value);
    return cursors&&Object.entries(cursors).every(([jid,cursor])=>linked('chats','jid',jid)&&
     (typeof cursor==='string'||!!object(cursor)&&typeof object(cursor)!.timestamp==='string'&&typeof object(cursor)!.id==='string'))?resource():closed();
   }
   if(typeof row.key==='string'&&row.key.startsWith('oom_exits:'))return typeof row.value==='string'&&/^\d+$/.test(row.value)?resource():closed();
   return closed();
  }
  case 'messages': {
   if(row.is_from_me===1&&oneOf(row.delivery_status,[null,'released','cancelled','rejected']))return passive();
   if(oneOf(row.delivery_status,['cancelled','rejected']))return decision('terminal','original_input_terminal_state');
   const execution=all('wecom_conversation_execution').find(item=>item.workspace_jid===row.chat_jid&&item.message_id===row.id);
   if(cancelled(execution))return cancelledFact();
   return execution?.state==='completed'&&all('wecom_conversation_results').some(item=>item.receipt_id===execution.receipt_id)?passive():closed();
  }
  case 'wecom_conversation_receipts':return cancelled(all('wecom_conversation_execution').find(item=>item.receipt_id===row.receipt_id))?cancelledFact():all('wecom_conversation_execution').some(item=>item.receipt_id===row.receipt_id&&item.state==='completed')?passive():closed();
  case 'wecom_conversation_execution':return cancelled(row)?cancelledFact():row.state==='completed'&&all('wecom_conversation_results').some(item=>item.receipt_id===row.receipt_id)?passive():closed();
  case 'wecom_conversation_results':return facts.evidence.includes('d5_frozen_result_verified')?passive():closed();
  // A terminal label does not settle a notification lease or provider outcome.
  // Exact preserved task rows are handled above; other executable families
  // require their original stop/reconciliation contract before support expands.
  default:return closed();
 }
}

export function isPassiveOriginalRunnerSnapshot(relative:string,kind:string,registeredFolders:ReadonlySet<string>):boolean {
 const segments=relative.split('/');
 return kind==='ipc/snapshot'&&segments.length===3&&segments[0]==='ipc'&&registeredFolders.has(segments[1]!)&&
  ['current_tasks.json','available_groups.json'].includes(segments[2]!);
}

export function classifyRestorationResidue(kind:string,evidence:readonly string[]):RestorationDecision {
 if(evidence.includes('root_absent')||evidence.includes('directory_observed'))return decision('eligible','descriptor_traversed_namespace');
 if(kind==='residue/ipc/snapshot'&&evidence.includes('passive_original_runner_snapshot'))
  return decision('eligible','passive_snapshot_no_automatic_consumer');
 if(kind==='residue/config/opaque'&&evidence.includes('original_im_migration_presence_marker'))
  return decision('eligible','passive_migration_presence_marker');
 // Regular files require a content/protocol verifier; metadata is never an ACK.
 return decision('blocked','unsupported_residue_protocol:'+kind);
}
