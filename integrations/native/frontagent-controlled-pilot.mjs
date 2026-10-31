import {createHash} from 'node:crypto';

const digest=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const denied=()=>Error('FRONTAGENT_PILOT_ADMISSION_DENIED');
const forbidden=async()=>{throw Error('EXISTING_RESOURCE_CREATION_FORBIDDEN');};
const actorFrom=context=>({tenantId:context.identity.tenantId,accountId:context.identity.accountId,storeId:context.identity.storeId,grantVersion:context.identity.grantVersion,...context.channel});

/** Assemble the real bot around an already restored, existing Frontagent host. */
export async function prepareExistingFrontagentPilot(options){
 const {gate,db,host,grants,ledger,tasks,readBindings,readApproved,readCredentials,modules,journalDirectory}=options;
 const descriptor=structuredClone(options.descriptor);
 const {runId,expiresAt}=options;
 if(!descriptor||!gate||host?.fullHostBootGate!==gate||gate.phase()!=='ready'||!host.fullHostQueue||
    !Number.isSafeInteger(expiresAt)||expiresAt<=Date.now()||expiresAt>Date.now()+1800000||
    typeof runId!=='string'||!runId||typeof journalDirectory!=='string'||!journalDirectory||
    [readBindings,readApproved,readCredentials].some(fn=>typeof fn!=='function'))throw denied();
 const initialize=host.initializeControlledRealFullHostConversationExecution?.bind(host);
 if(typeof initialize!=='function')throw denied();
 const initialCredentials=readCredentials();
 if(!initialCredentials?.botId||!initialCredentials?.corpId||typeof initialCredentials.secret!=='string'||!initialCredentials.secret.trim())throw denied();
 const {botId,corpId,secret}=initialCredentials;
 const matching=()=>{const rows=readBindings();if(!Array.isArray(rows))throw denied();return rows.filter(row=>row.active&&row.accountId===descriptor.accountId);};
 const rows=matching();
 if(rows.length!==1||rows[0].botId!==botId||rows[0].corpId!==corpId||!rows[0].memberId||!Number.isSafeInteger(rows[0].version)||rows[0].version<1)throw denied();
 const binding=structuredClone(rows[0]);
 const grant=grants.get(descriptor.accountId);
 if(!grant?.active||grant.storeId!==descriptor.storeId||grant.roles?.length!==1||grant.roles[0]!=='marketing'||!Number.isSafeInteger(grant.version))throw denied();
 const grantVersion=grant.version;
 const verifyResources=()=>{
  const user=db.getUserById(descriptor.accountId),homes=db.getGroupsByOwner(descriptor.accountId),group=db.getRegisteredGroup(descriptor.workspaceJid),profile=db.getAgentProfileForUser(descriptor.profileId,descriptor.accountId);
  if(!user||user.id!==descriptor.accountId||user.role!=='member'||user.status!=='active'||user.must_change_password!==false||!Array.isArray(homes))throw denied();
  const ownHomes=homes.filter(item=>item.is_home);
  if(ownHomes.length!==1||ownHomes[0].jid!==descriptor.homeJid||ownHomes[0].created_by!==descriptor.accountId||ownHomes[0].executionMode!=='container'||
     !group||group.jid!==descriptor.workspaceJid||group.folder!==descriptor.folder||group.created_by!==descriptor.accountId||group.is_home||group.executionMode!=='container'||
     !profile||profile.id!==descriptor.profileId||profile.owner_user_id!==descriptor.accountId||profile.status!=='active'||db.getWorkspaceAgentProfileId(descriptor.folder)!==descriptor.profileId)throw denied();
 };
 const approval=()=>{const all=readApproved();if(!Array.isArray(all))throw denied();
  const expected={tenantId:descriptor.tenantId,accountId:descriptor.accountId,storeId:descriptor.storeId,role:'marketing',profileId:descriptor.profileId,workspaceJid:descriptor.workspaceJid,botId,corpId,memberId:binding.memberId};
  if(all.filter(row=>Object.entries(expected).every(([key,value])=>row[key]===value)).length!==1)throw denied();return all;
 };
 const live=()=>{
  if(gate.phase()!=='ready'||Date.now()>=expiresAt)throw denied();
  const now=matching(),g=grants.get(descriptor.accountId),creds=readCredentials();
  if(now.length!==1||['botId','corpId','memberId','accountId','version'].some(key=>now[0][key]!==binding[key])||
     !g?.active||g.version!==grantVersion||g.storeId!==descriptor.storeId||g.roles?.length!==1||g.roles[0]!=='marketing'||
     creds?.botId!==botId||creds?.corpId!==corpId||creds?.secret!==secret)throw denied();
  approval();verifyResources();
 };
 live();
 const identity={tenantId:descriptor.tenantId,stores:[{id:descriptor.storeId}],roles:['marketing'],store:grants,
  readBinding:modules.createWecomBotBindingReader(async()=>readBindings()),
  readNative:async accountId=>{if(accountId!==descriptor.accountId)throw denied();live();return {user:db.getUserById(accountId),workspaceJid:descriptor.homeJid};}};
 const authority=modules.createControlledRealWecomBotContext({...identity,mode:'controlled-real-pilot',botId,corpId,readSubject:async()=>({botId,memberId:binding.memberId})});
 let pilot,closed=false;
 try{
  const request={signal:new AbortController().signal,deadline:performance.now()+30000,correlationId:'frontagent-existing-pilot'};
  const readActor=async scope=>({...actorFrom(await authority.authorize({...scope,correlationId:'frontagent-existing-current'},'marketing')),role:'marketing'});
  const issued=await authority.authorize(request,'marketing'),actor=actorFrom(issued);
  live();
  const adopted=await modules.createExistingRoleWorkspaceAdopter({gate,native:db,readActor,approvedResources:approval()}).adopt({
   actor:{...actor,role:'marketing'},scope:request,idempotencyKey:digest([actor.tenantId,actor.accountId,actor.storeId,'marketing']),
   assertCurrent:()=>authority.assertCurrent(issued),withCurrent:work=>authority.withCurrent(issued,work),
  });
  if(adopted?.state!=='ready'||adopted.workspaceJid!==descriptor.workspaceJid||adopted.profileId!==descriptor.profileId)throw denied();
  await authority.assertCurrent(issued);live();
  const fingerprint=()=>{live();return {botId,corpId,ownerId:descriptor.accountId,configVersion:String(binding.version),credentialFingerprint:digest(secret),workspaceFingerprint:digest(descriptor.workspaceJid)};};
  const f=fingerprint();
  pilot=modules.createControlledRealWecomBotPilot({mode:'controlled-real-pilot',
   admission:{mode:'controlled-real-pilot',environment:'local-test',runId,expiresAt,botId,corpId,memberId:binding.memberId,accountId:descriptor.accountId,tenantId:descriptor.tenantId,storeId:descriptor.storeId,roles:['marketing'],bindingVersion:binding.version,configVersion:f.configVersion,credentialFingerprint:f.credentialFingerprint,workspaceFingerprint:f.workspaceFingerprint},
   secret,identity,business:{scope:{tenant:descriptor.tenantId,store:descriptor.storeId,workspace:descriptor.homeJid},employees:[{...descriptor.employee,accountId:descriptor.accountId}],ledger,store:tasks},
   initializeExecution:input=>{const execution=initialize(input);if(execution.queue!==host.fullHostQueue||execution.gate!==gate)throw Error('FRONTAGENT_HOST_EXECUTION_CHANGED');return execution;},
   authorize:receipt=>{try{live();return !!receipt&&receipt.role==='marketing'&&Object.entries(actor).every(([key,value])=>receipt.actor?.[key]===value);}catch{return false;}},
   createIntake:execution=>modules.createControlledRealBotConversationNativePort({mode:'controlled-real-pilot',gate:execution.gate,native:db,readActor,execution}),
   createRoles:roleGate=>{const port=modules.createControlledRealRoleWorkspaceNativePort({mode:'controlled-real-pilot',gate:roleGate,native:db,templates:[],prepareOwnProfiles:forbidden,journalDirectory,readActor});return {readRoleWorkspace:port.readRoleWorkspace,prepareRoleWorkspace:forbidden};},
   readFingerprint:fingerprint,...(options.onDelivery?{onDelivery:options.onDelivery}:{}),...(options.onOutcome?{onOutcome:options.onOutcome}:{})
  });
  if(await pilot.prepare()!=='prepared')throw Error('FRONTAGENT_PILOT_PREPARE_FAILED');
  live();
  return Object.freeze({activate:()=>{live();return pilot.activate();},status:()=>pilot.status(),idle:()=>pilot.idle(),close:async()=>{if(closed)return;closed=true;try{await pilot.close();}finally{authority.close();}}});
 }catch(error){
  let cleanupUnknown=false;
  if(pilot)try{await pilot.close();if(pilot.status()!=='closed')cleanupUnknown=true;}catch{cleanupUnknown=true;}
  try{authority.close();}catch{cleanupUnknown=true;}
  if(cleanupUnknown){const failure=Error('FRONTAGENT_PILOT_CLEANUP_UNKNOWN');Object.defineProperty(failure,'originalError',{value:error,enumerable:false});throw failure;}
  throw error;
 }
}
