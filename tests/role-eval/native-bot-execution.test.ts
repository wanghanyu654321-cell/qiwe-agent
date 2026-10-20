import {expect,it,vi} from 'vitest';
import {createNativeBotExecutionPort} from '../../src/role-eval/native-bot-execution.js';
import {createNativeBotTasks} from '../../src/role-eval/native-bot-tasks.js';
import type {BotTaskOwner} from '../../src/role-eval/wecom-bot-task-store.js';
const owner:BotTaskOwner={tenantId:'t',storeId:'s',accountId:'a',workspaceJid:'web:home',role:'marketing',corpId:'c',botId:'b',memberId:'m',bindingVersion:1};
const backend={kind:'native' as const,taskId:'task',profileId:'profile',workspaceJid:'web:role'};
const scope=()=>({signal:new AbortController().signal,deadline:performance.now()+2000});
function fixture(){
 const task={id:'task',chat_jid:'web:role',group_folder:'role',context_mode:'isolated',execution_type:'agent',execution_mode:'container',status:'active',deleted_at:null};
 const group={jid:'web:role',folder:'role',created_by:'a',is_home:false,executionMode:'container'};
 const profile={id:'profile',owner_user_id:'a',status:'active'};
 const run={id:'run',task_id:'task',idempotency_key:'key',trigger_type:'manual',status:'running',result:null,definition_snapshot:{chat_jid:'web:role',group_folder:'role',context_mode:'isolated',execution_type:'agent',execution_mode:'container'}};
 const readers={getTaskById:()=>task,getRegisteredGroup:()=>group,getAgentProfile:()=>profile,getWorkspaceAgentProfileBinding:()=>({agent_profile_id:'profile'}),getTaskRunById:()=>run};
 const target={triggerTaskRunTargeted:vi.fn(async(_id:string,_key:string,admission:any):Promise<unknown>=>{let out;await admission.withCurrent(()=>{admission.revalidate();out={success:true,runId:'run'};});return out;}),cancelTaskRunTargeted:vi.fn(async(_id:string,admission:any):Promise<unknown>=>{let out;await admission.withCurrent(()=>{admission.revalidate();run.status='cancelled';out={success:true};});return out;})};
 return {task,group,profile,run,target,options:{mode:'isolated-synthetic' as const,enabled:true,readers,target}};
}
const current=async()=>{};
const withCurrent=async(work:()=>void)=>{work();};
it('defaults disabled and requires an explicit grant transaction before any action',async()=>{
 const f=fixture(),port=createNativeBotExecutionPort({...f.options,enabled:undefined}),adapter=createNativeBotTasks({port});
 expect(await adapter.start(owner,backend,'key',scope(),current,withCurrent)).toMatchObject({state:'blocked'});expect(f.target.triggerTaskRunTargeted).not.toHaveBeenCalled();
 const enabled=createNativeBotTasks({port:createNativeBotExecutionPort(f.options)});
 expect(await enabled.start(owner,backend,'key',scope(),current)).toMatchObject({state:'blocked'});expect(f.target.triggerTaskRunTargeted).not.toHaveBeenCalled();
});
it('binds each invocation to its actor and revalidates inside the supplied original grant transaction',async()=>{
 const f=fixture(),adapter=createNativeBotTasks({port:createNativeBotExecutionPort(f.options)});let locked=false;
 const tx=async(work:()=>void)=>{locked=true;try{work();}finally{locked=false;}};
 f.target.triggerTaskRunTargeted.mockImplementation(async(_id,_key,admission)=>{let result;await admission.withCurrent(()=>{expect(locked).toBe(true);admission.revalidate();result={success:true,runId:'run'};});return result;});
 expect(await adapter.start(owner,backend,'key',scope(),current,tx)).toMatchObject({state:'linked',referenceId:'run'});
 expect(await adapter.start({...owner,accountId:'other'},backend,'key',scope(),current,tx)).toMatchObject({state:'blocked'});expect(f.target.triggerTaskRunTargeted).toHaveBeenCalledTimes(1);
 expect(await adapter.cancel(owner,backend,'key','run',scope(),current,tx)).toMatchObject({state:'requested'});expect(f.run.status).toBe('cancelled');
});
it.each(['owner','profile','group','script','host','home','binding','aborted'])('rejects %s changed after inspection before reserve',async reason=>{
 const f=fixture(),controller=new AbortController(),s={signal:controller.signal,deadline:performance.now()+2000};const adapter=createNativeBotTasks({port:createNativeBotExecutionPort(f.options)});
 const tx=async(work:()=>void)=>{if(reason==='owner')f.group.created_by='other';if(reason==='profile')f.profile.status='paused';if(reason==='group')f.task.context_mode='group';if(reason==='script')f.task.execution_type='script';if(reason==='host')f.group.executionMode='host';if(reason==='home')f.group.is_home=true;if(reason==='binding')f.profile.id='other';if(reason==='aborted')controller.abort();work();};
 expect(await adapter.start(owner,backend,'key',s,current,tx)).toMatchObject({state:'unknown'});expect(f.target.triggerTaskRunTargeted).toHaveBeenCalledTimes(1);
});
it('does not allow cancellation of a different key and captures functions and opt-in once',async()=>{
 const f=fixture(),port=createNativeBotExecutionPort(f.options),adapter=createNativeBotTasks({port});
 f.options.enabled=false;f.options.target.triggerTaskRunTargeted=vi.fn(async()=>{throw Error('replacement');});
 expect(await adapter.start(owner,backend,'key',scope(),current,withCurrent)).toMatchObject({state:'linked'});
 f.run.idempotency_key='other';expect(await adapter.cancel(owner,backend,'key','run',scope(),current,withCurrent)).toMatchObject({state:'blocked'});expect(f.target.cancelTaskRunTargeted).not.toHaveBeenCalled();
});
it('fences a grant provider retaining its callback after it already returned without running the transaction',async()=>{
 const f=fixture();let retained!:(()=>void),actions=0;
 f.target.triggerTaskRunTargeted.mockImplementation(async(_id,_key,a)=>{await a.withCurrent(()=>{actions++;});return {success:true,runId:'run'};});
 const port=createNativeBotExecutionPort(f.options);
 // A direct call deliberately supplies a still-live scope; it must not depend
 // on the outer adapter aborting its child scope to fence this late callback.
 const raw={owner,backend,key:'key',withCurrent:async(work:()=>void)=>{retained=work;}};
 await expect(port.trigger('task','key',scope(),raw)).rejects.toThrow('native_execution_missing_transaction');
 expect(()=>retained()).toThrow('native_execution_transaction_closed');expect(actions).toBe(0);
});
