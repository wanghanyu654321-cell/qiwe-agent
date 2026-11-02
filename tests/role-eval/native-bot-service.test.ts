import {expect,it,vi} from 'vitest';
import {createNativeBotReadPort} from '../../src/role-eval/native-bot-service.js';
import {createNativeBotTasks} from '../../src/role-eval/native-bot-tasks.js';
import type {BotTaskOwner} from '../../src/role-eval/wecom-bot-task-store.js';
const owner:BotTaskOwner={tenantId:'tenant',storeId:'store',accountId:'account',workspaceJid:'web:home',role:'marketing',corpId:'corp',botId:'bot',memberId:'member',bindingVersion:1};
const backend={kind:'native' as const,taskId:'task',profileId:'profile',workspaceJid:'web:role'};
const scope=()=>({signal:new AbortController().signal,deadline:performance.now()+2000});
function fixture(){
 const task={id:'task',chat_jid:'web:role',group_folder:'role-folder',context_mode:'isolated',execution_type:'agent',execution_mode:'container',status:'active',deleted_at:null,prompt:'private task prompt'};
 const group={jid:'web:role',folder:'role-folder',created_by:'account',is_home:false,executionMode:'container',secret:'private group metadata'};
 const profile={id:'profile',owner_user_id:'account',status:'active',system_prompt:'private profile prompt'};
 const binding={agent_profile_id:'profile',group_folder:'role-folder'};
 const run={id:'run',task_id:'task',idempotency_key:'key',trigger_type:'manual',status:'success',result:'原服务持久结果',definition_snapshot:{chat_jid:'web:role',group_folder:'role-folder',context_mode:'isolated',execution_type:'agent',execution_mode:'container',prompt:'private run prompt'}};
 const readers={getTaskById:vi.fn(()=>task as unknown),getRegisteredGroup:vi.fn(()=>group as unknown),getAgentProfile:vi.fn(()=>profile as unknown),getWorkspaceAgentProfileBinding:vi.fn(()=>binding as unknown),getTaskRunById:vi.fn(()=>run as unknown)};
 return {task,group,profile,binding,run,readers,options:{mode:'isolated-synthetic' as const,readers}};
}
it('maps real Native reader names, folder binding, camelCase group mode and parsed run without leaking private metadata',async()=>{
 const f=fixture(),port=createNativeBotReadPort(f.options);
 const row=await port.inspect(owner,backend,scope());
 expect(row).toEqual({task:{id:'task',chat_jid:'web:role',group_folder:'role-folder',context_mode:'isolated',execution_type:'agent',execution_mode:'container',status:'active',deleted_at:null},group:{jid:'web:role',folder:'role-folder',created_by:'account',is_home:false,execution_mode:'container'},profile:{id:'profile',owner_user_id:'account',status:'active'},bindingProfileId:'profile'});
 expect(f.readers.getTaskById).toHaveBeenCalledWith('task');expect(f.readers.getRegisteredGroup).toHaveBeenCalledWith('web:role');expect(f.readers.getWorkspaceAgentProfileBinding).toHaveBeenCalledWith('role-folder');expect(f.readers.getAgentProfile).toHaveBeenCalledWith('profile');
 const saved=await port.getRun('run',scope());expect(JSON.stringify(saved)).not.toContain('private');
 expect(await createNativeBotTasks({port}).query(owner,backend,'key','run',scope(),async()=>{})).toMatchObject({status:'success',output:'原服务持久结果'});
 f.run.definition_snapshot.group_folder='later-change';expect(saved).toMatchObject({definition_snapshot:{group_folder:'role-folder'}});
});
it('does not provide a path to execute or cancel the original scheduler',async()=>{
 const f=fixture(),port=createNativeBotReadPort(f.options),native=createNativeBotTasks({port});
 expect(port.enabled).toBe(false);expect(await native.start(owner,backend,'key',scope(),async()=>{})).toMatchObject({state:'blocked',detail:'native_disabled'});
 expect(await native.cancel(owner,backend,'key','run',scope(),async()=>{})).toMatchObject({state:'blocked',detail:'native_disabled'});
 expect(f.readers.getTaskById).not.toHaveBeenCalled();
 await expect(port.trigger('task','key',scope())).rejects.toThrow('native_disabled');await expect(port.cancelRun('run',scope())).rejects.toThrow('native_disabled');
 expect(()=>Reflect.set(port,'enabled',true)).not.toThrow();expect(port.enabled).toBe(false);
 expect(()=>createNativeBotReadPort({...f.options,enabled:true} as never)).toThrow('invalid_native_read_port');
 expect(()=>createNativeBotReadPort({...f.options,readers:{...f.readers,triggerTaskNow:()=>{throw Error('must_not_execute');}}} as never)).toThrow('invalid_native_read_port');
});
it.each(['owner','profile','binding','home','host','script','task-workspace','run-key','snapshot'])('keeps original T5 verification for invalid %s',async reason=>{
 const f=fixture();
 if(reason==='owner')f.group.created_by='other';if(reason==='profile')f.profile.owner_user_id='other';if(reason==='binding')f.binding.agent_profile_id='other';if(reason==='home')f.group.is_home=true;if(reason==='host')f.group.executionMode='host';if(reason==='script')f.task.execution_type='script';if(reason==='task-workspace')f.task.chat_jid='web:other';if(reason==='run-key')f.run.idempotency_key='wrong';if(reason==='snapshot')f.run.definition_snapshot.group_folder='wrong';
 expect((await createNativeBotTasks({port:createNativeBotReadPort(f.options)}).query(owner,backend,'key','run',scope(),async()=>{})).status).toBe('unknown');
});
it.each(['missing-task','missing-binding','string-snapshot','accessor','promise'])('refuses unverified %s instead of repairing original state',async reason=>{
 const f=fixture();let getter=0;
 if(reason==='missing-task')f.readers.getTaskById.mockReturnValue(undefined);if(reason==='missing-binding')f.readers.getWorkspaceAgentProfileBinding.mockReturnValue(undefined);
 if(reason==='string-snapshot')f.readers.getTaskRunById.mockReturnValue({...f.run,definition_snapshot:JSON.stringify(f.run.definition_snapshot)});
 if(reason==='accessor')f.readers.getRegisteredGroup.mockReturnValue({...f.group,get executionMode(){getter++;return 'container';}});
 if(reason==='promise')f.readers.getTaskById.mockReturnValue(Promise.resolve(f.task));
 expect((await createNativeBotTasks({port:createNativeBotReadPort(f.options)}).query(owner,backend,'key','run',scope(),async()=>{})).status).toBe('unknown');expect(getter).toBe(0);
});
it('captures reader functions, respects abort between reads, and closes only its own bridge',async()=>{
 const f=fixture(),port=createNativeBotReadPort(f.options),controller=new AbortController();
 f.readers.getTaskById=vi.fn(()=>{throw Error('mutable replacement must not run');});
 await expect(port.inspect(owner,backend,scope())).resolves.toHaveProperty('bindingProfileId','profile');
 const g=fixture();g.readers.getTaskById.mockImplementation(()=>{controller.abort();return g.task;});
 await expect(createNativeBotReadPort(g.options).inspect(owner,backend,{signal:controller.signal,deadline:performance.now()+2000})).rejects.toThrow('native_read_cancelled');expect(g.readers.getRegisteredGroup).not.toHaveBeenCalled();
 port.close();await expect(port.getRun('run',scope())).rejects.toThrow('native_read_closed');
 expect(f.readers.getTaskRunById()).toEqual(f.run);
});
it.each([false,true])('consumes a rejected async reader without accepting it, including simultaneous abort=%s',async abort=>{
 const f=fixture(),controller=new AbortController(),failure=Error('synthetic_rejected_reader'),unhandled:unknown[]=[];
 const listener=(reason:unknown)=>{if(reason===failure)unhandled.push(reason);};process.on('unhandledRejection',listener);
 try{
  // A vi.fn would observe returned Promise settlement itself and mask this bug.
  const readers={...f.readers,getTaskById:()=>{if(abort)controller.abort();return Promise.reject(failure);}};
  await expect(createNativeBotReadPort({mode:'isolated-synthetic',readers}).inspect(owner,backend,{signal:controller.signal,deadline:performance.now()+2000})).rejects.toThrow(abort?'native_read_cancelled':'native_read_unverifiable');
  await new Promise<void>(resolve=>setImmediate(resolve));expect(unhandled).toEqual([]);
  expect(f.readers.getRegisteredGroup).not.toHaveBeenCalled();
 }finally{process.off('unhandledRejection',listener);}
});
