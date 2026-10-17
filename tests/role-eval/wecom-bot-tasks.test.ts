import {afterEach,it,expect} from 'vitest';import fs from 'node:fs';import {tmpdir} from 'node:os';import path from 'node:path';import {createHash} from 'node:crypto';
import {WorkbenchAccessStore} from '../../src/role-eval/workbench-access.js';import {createWecomBotContext} from '../../src/role-eval/wecom-bot-context.js';
import {BotTaskStore} from '../../src/role-eval/wecom-bot-task-store.js';import {createBotTasks} from '../../src/role-eval/wecom-bot-tasks.js';import {parseBotTaskCommand} from '../../src/role-eval/wecom-bot-task-commands.js';
import {createTrainingGenerationService} from '../../src/role-eval/training-generation.js';import {createTrainingSummaryService} from '../../src/role-eval/training-knowledge.js';
import {ManagerStore} from '../../src/role-eval/manager-store.js';import {createBotDelivery} from '../../src/role-eval/wecom-bot-delivery.js';import {createBotSender} from '../../src/role-eval/wecom-bot-sender.js';
import {createNativeBotTasks} from '../../src/role-eval/native-bot-tasks.js';
const cleanup:(()=>void)[]=[];afterEach(()=>{for(const close of cleanup.splice(0).reverse())close();});
function setup(){
 const dir=fs.mkdtempSync(path.join(tmpdir(),'bot-tasks-'));cleanup.push(()=>fs.rmSync(dir,{recursive:true,force:true}));
 const grants=new WorkbenchAccessStore(path.join(dir,'grants.sqlite')),store=new BotTaskStore(path.join(dir,'existing.sqlite'));cleanup.push(()=>grants.close(),()=>store.close());
 const open=(roles:('training'|'marketing')[]=['training','marketing'])=>grants.change('admin',{accountId:'a',storeId:'b',active:true,roles,expectedVersion:grants.get('a')?.version??0,requestKey:'grant-'+(grants.get('a')?.version??0)});open();
 let member='member-a',account='a',home='web:home-a';
 const authority=createWecomBotContext({mode:'isolated-synthetic',botId:'bot',corpId:'corp',tenantId:'tenant',stores:[{id:'b'}],roles:['training','marketing'],store:grants,readSubject:async()=>({botId:'bot',memberId:member}),readBinding:async()=>({botId:'bot',corpId:'corp',memberId:member,accountId:account,active:true,version:1}),readNative:async()=>({user:{id:account,role:'member',status:'active',must_change_password:false},workspaceJid:home})});cleanup.push(()=>authority.close());
 const scope={accountId:'a',workspaceJid:'web:local-training'},body='# 合成培训\n\n## 家访练习\n先访谈，再演练，最后复盘。',sha=createHash('sha256').update(body).digest('hex');
 fs.writeFileSync(path.join(dir,'approval.json'),JSON.stringify({kind:'user_provided_summary',scope,sha256:sha,fileName:'synthetic.md'}));fs.writeFileSync(path.join(dir,'summary-'+sha+'.json'),JSON.stringify({scope,sha256:sha,sourceText:body}));
 const knowledge=createTrainingSummaryService(dir,scope);let generated=0,finish!:(value:unknown)=>void;
 const training=createTrainingGenerationService({dir:path.join(dir,'runs'),scope,knowledge,timeoutMs:2000,generate:async()=>{generated++;return new Promise(r=>{finish=r;});}});cleanup.push(()=>training.close());
 let triggers=0,cancels=0,runStatus='running',nativeUnknown=false,nativeKey='',nativeOutput='合成岗位任务结果',cancelUnknown=false;
 const native=createNativeBotTasks({port:{mode:'isolated-synthetic',enabled:true,
 inspect:async()=>({task:{id:'existing-task',chat_jid:'web:role-marketing',group_folder:'role-marketing',execution_type:'agent',execution_mode:'container',status:'active',deleted_at:null},group:{jid:'web:role-marketing',folder:'role-marketing',created_by:'a',execution_mode:'container',is_home:0},profile:{id:'existing-profile',owner_user_id:'a',status:'active'},bindingProfileId:'existing-profile'}),
 trigger:async(_task,key)=>{triggers++;nativeKey=key;return nativeUnknown?{success:true}:{success:true,runId:'run-original'};},
 getRun:async()=>({id:'run-original',task_id:'existing-task',idempotency_key:nativeKey,trigger_type:'manual',status:runStatus,result:runStatus==='success'?nativeOutput:null,definition_snapshot:{chat_jid:'web:role-marketing',group_folder:'role-marketing',execution_type:'agent',execution_mode:'container'}}),cancelRun:async()=>{cancels++;if(cancelUnknown)throw Error('synthetic-cancel-unknown');return {success:true};}}});cleanup.push(()=>native.close());
 const options={mode:'isolated-synthetic' as const,authority,store,native,catalog:[{tenantId:'tenant',storeId:'b',accountId:'a',homeJid:'web:home-a',role:'marketing' as const,alias:'weekly',taskId:'existing-task',profileId:'existing-profile',workspaceJid:'web:role-marketing'}],training:{enabled:true,resolve:()=>training}};
 const service=createBotTasks(options);cleanup.push(()=>service.close());let message=0,frame:unknown;const replies:string[]=[];
 const ledger=new ManagerStore(path.join(dir,'existing.sqlite'));cleanup.push(()=>ledger.close());const sender=createBotSender({sdk:{mode:'isolated-synthetic',ready:()=>true,reply:async(f,b)=>{replies.push(b.stream.content);return {headers:{req_id:f.headers.req_id},errcode:0};},sendMessage:async()=>{throw Error('unexpected_proactive_send');}}});
 const app=createBotDelivery({mode:'isolated-synthetic',authority,ledger,tasks:service,scope:{tenant:'tenant',store:'b',workspace:'web:original-ledger'},employees:[{accountId:'a',employeeId:'original-a',employeeName:'合成员工'}],readEvent:()=>frame,sender});cleanup.push(()=>app.close());
 const request=()=>({correlationId:'tasks',signal:new AbortController().signal,deadline:performance.now()+2000});
 const execute=async(text:string,id='event-'+ ++message,withService=service)=>{const command=parseBotTaskCommand(text)!;const req=request(),context=await authority.authorize(req,command.role);return withService.execute(context,{reqId:'req-'+id,botId:'bot',memberId:member,messageId:id,action:{kind:'text',text}},command,req);};
 const messageInApp=(content:string,id='app-'+ ++message)=>{frame={cmd:'aibot_msg_callback',headers:{req_id:'req-'+id},body:{aibotid:'bot',msgid:id,chattype:'single',from:{userid:member},msgtype:'text',text:{content}}};return app.handle(request());};
 return {dir,store,options,service,execute,authority,training,knowledge,scope,open,replies,ledger,messageInApp,finish:()=>finish({answer:'合成建议：先访谈再演练。',lesson:null,citations:[knowledge.search('家访').matches[0]!.id],limitations:['合成练习，人工审核。']}),setNativeUnknown:()=>{nativeUnknown=true;},setCancelUnknown:()=>{cancelUnknown=true;},setNativeOutput:(v:string)=>{nativeOutput=v;},completeNative:()=>{runStatus='success';},cancelNative:()=>{runStatus='cancelled';},counts:()=>({triggers,cancels,generated}),moveHome:()=>{home='web:other-home';},switchMember:()=>{member='member-b';account='b';}};
}
it('links one existing original task and never reruns a duplicate event after restart',async()=>{
 const s=setup(),first=await s.execute('执行任务 内容营销 weekly','same');expect(first.taskId).toMatch(/^[a-f0-9]{64}$/);expect(s.counts().triggers).toBe(1);
 const fresh=createBotTasks(s.options);cleanup.push(()=>fresh.close());expect((await s.execute('执行任务 内容营销 weekly','same',fresh)).taskId).toBe(first.taskId);expect(s.counts().triggers).toBe(1);s.completeNative();expect((await s.execute('查询任务 内容营销 '+first.taskId)).content).toContain('合成岗位任务结果');
});
it('keeps an unknown original submission unknown and does not retry it',async()=>{
 const s=setup();s.setNativeUnknown();const first=await s.execute('执行任务 内容营销 weekly','unknown');expect(first.status).toBe('unknown');await s.execute('执行任务 内容营销 weekly','unknown');expect(s.counts().triggers).toBe(1);expect((await s.execute('查询任务 内容营销 '+first.taskId)).status).toBe('unknown');
});
it('keeps cancel acceptance separate from the original task terminal and suppresses duplicate cancels',async()=>{
 const s=setup(),r=await s.execute('执行任务 内容营销 weekly');const cancel=await s.execute('取消任务 内容营销 '+r.taskId);expect(cancel.content).toContain('取消请求');expect(s.counts().cancels).toBe(1);await s.execute('取消任务 内容营销 '+r.taskId);expect(s.counts().cancels).toBe(1);s.cancelNative();expect((await s.execute('查询任务 内容营销 '+r.taskId)).status).toBe('cancelled');
});
it('uses the original training service for cited output and cancels only its own run',async()=>{
 const s=setup(),r=await s.execute('培训问答 指导员 家访练习');expect(s.counts().generated).toBe(1);const task=s.store.get({tenantId:'tenant',storeId:'b',accountId:'a',workspaceJid:'web:home-a',role:'training',corpId:'corp',botId:'bot',memberId:'member-a',bindingVersion:1},r.taskId!);expect(task).toBeDefined();
 s.finish();await s.training.settled(task!.backend.kind==='training'?task!.backend.requestKey:'bad');expect((await s.execute('查询任务 培训 '+r.taskId)).content).toContain('合成建议');
 const second=await s.execute('培训问答 指导员 家访再练习');expect((await s.execute('取消任务 培训 '+second.taskId)).content).toContain('取消');s.finish();expect((await s.execute('查询任务 培训 '+second.taskId)).status).toBe('cancelled');
});
it('does not expose a task after role revocation or Native Home replacement',async()=>{
 const s=setup(),r=await s.execute('执行任务 内容营销 weekly');s.open(['training']);await expect(s.execute('查询任务 内容营销 '+r.taskId)).rejects.toThrow('access_denied');s.open();s.moveHome();expect((await s.execute('查询任务 内容营销 '+r.taskId)).status).toBe('not-found');expect(s.counts().cancels).toBe(0);
});
it('blocks missing routes and disabled training without invoking an executor',async()=>{
 const s=setup();expect((await s.execute('执行任务 内容营销 other')).status).toBe('blocked');const disabled=createBotTasks({...s.options,training:{...s.options.training,enabled:false}});cleanup.push(()=>disabled.close());expect((await s.execute('培训问答 指导员 家访练习','disabled',disabled)).status).toBe('blocked');expect(s.counts()).toEqual({triggers:0,cancels:0,generated:0});
});
it('routes employee task commands through current role authorization and the existing durable reply outbox',async()=>{
 const s=setup(),start=await s.messageInApp('执行任务 内容营销 weekly','same-app');expect(start.result.status).toBe('task');expect(start.result.taskId).toMatch(/^[a-f0-9]{64}$/);expect(start.delivery?.state).toBe('accepted');
 expect((await s.messageInApp('执行任务 内容营销 weekly','same-app')).suppressed).toBe(true);expect(s.counts().triggers).toBe(1);expect(s.replies).toHaveLength(1);
 s.completeNative();const query=await s.messageInApp('查询任务 内容营销 '+start.result.taskId);expect(query.result.reply.body.stream.content).toContain('合成岗位任务结果');expect(s.ledger.list({tenant:'tenant',store:'b',workspace:'web:original-ledger',employeeId:'original-a',employeeName:'合成员工'})).toEqual([]);
});
it('allows a training-only employee to submit, cancel and look up their own result without granting manager access',async()=>{
 const s=setup();s.open(['training']);const r=await s.messageInApp('培训问答 指导员 家访练习');expect(r.result.status).toBe('task');const cancelled=await s.messageInApp('取消任务 培训 '+r.result.taskId);expect(cancelled.result.reply.body.stream.content).toContain('已取消');
 expect((await s.messageInApp('查询任务 培训 '+r.result.taskId)).result.reply.body.stream.content).toContain('已取消');await expect(s.messageInApp('今天销售成交20元')).rejects.toThrow('access_denied');
});
it('never cancels a different original training run when the trusted service mapping changes',async()=>{
 const s=setup(),first=await s.execute('培训问答 指导员 家访练习','original');const owner={tenantId:'tenant',storeId:'b',accountId:'a',workspaceJid:'web:home-a',role:'training' as const,corpId:'corp',botId:'bot',memberId:'member-a',bindingVersion:1};const ref=s.store.get(owner,first.taskId!)!;
 if(ref.backend.kind!=='training')throw Error('fixture');const key=ref.backend.requestKey,other=createTrainingGenerationService({dir:path.join(s.dir,'other-runs'),scope:s.scope,knowledge:s.knowledge,generate:async()=>new Promise(()=>{}),timeoutMs:2000});cleanup.push(()=>other.close());
 const input={requestKey:key,mode:'question' as const,persona:'instructor' as const,query:'家访练习'},otherRun=other.start(s.scope,input);expect(otherRun.id).not.toBe(ref.referenceId);
 const changed=createBotTasks({...s.options,training:{enabled:true,resolve:()=>other}});cleanup.push(()=>changed.close());await s.execute('取消任务 培训 '+first.taskId,'cancel-changed',changed);expect(other.get(s.scope,key).status).toBe('running');
});
it('refuses a command that does not match the authenticated event content before invoking a backend',async()=>{
 const s=setup(),request={correlationId:'mismatch',signal:new AbortController().signal,deadline:performance.now()+1000},context=await s.authority.authorize(request,'marketing');
 await expect(s.service.execute(context,{reqId:'req',botId:'bot',memberId:'member-a',messageId:'mismatch',action:{kind:'text',text:'执行任务 内容营销 other'}},parseBotTaskCommand('执行任务 内容营销 weekly')!,request)).rejects.toThrow('task_command_conflict');expect(s.counts().triggers).toBe(0);
});
it('prevents task execution when the existing reply reservation owns a conflicting event fingerprint',async()=>{
 const s=setup(),id=createHash('sha256').update(JSON.stringify(['corp','bot','member-a','reserved'])).digest('hex');s.ledger.reserveBotReply({tenant:'tenant',store:'b',workspace:'web:original-ledger',employeeId:'original-a',employeeName:'合成员工'},{id,fingerprint:'a'.repeat(64),target:{corpId:'corp',botId:'bot',memberId:'member-a',bindingVersion:1,accountId:'a',workspaceJid:'web:home-a',storeId:'b'},reqId:'req-reserved'});
 await expect(s.messageInApp('执行任务 内容营销 weekly','reserved')).rejects.toThrow('bot_reply_conflict');expect(s.counts().triggers).toBe(0);expect(s.replies).toEqual([]);
});
it('claims one original execution and one reply when duplicate events race',async()=>{
 const s=setup(),results=await Promise.all([s.messageInApp('执行任务 内容营销 weekly','race'),s.messageInApp('执行任务 内容营销 weekly','race')]);expect(results[0]!.result.taskId).toBe(results[1]!.result.taskId);expect(s.counts().triggers).toBe(1);expect(s.replies).toHaveLength(1);
});
it('never retries an unknown cancellation through another message or claims the task stopped',async()=>{
 const s=setup(),r=await s.messageInApp('执行任务 内容营销 weekly');s.setCancelUnknown();const first=await s.messageInApp('取消任务 内容营销 '+r.result.taskId);expect(first.result.reply.body.stream.content).toContain('取消请求：结果未知');expect(first.result.taskStatus).toBe('running');await s.messageInApp('取消任务 内容营销 '+r.result.taskId);expect(s.counts().cancels).toBe(1);
});
it('keeps long original outputs queryable in bounded Unicode pages inside WeCom',async()=>{
 const s=setup(),r=await s.messageInApp('执行任务 内容营销 weekly');s.setNativeOutput('🌷'.repeat(2500)+'第二段');s.completeNative();const one=await s.messageInApp('查询任务 内容营销 '+r.result.taskId+' 1'),two=await s.messageInApp('查询任务 内容营销 '+r.result.taskId+' 2');expect(one.result.reply.body.stream.content).toContain('结果第1/2页');expect(two.result.reply.body.stream.content).toContain('第二段');expect(Buffer.byteLength(one.result.reply.body.stream.content)).toBeLessThan(16384);expect(one.result.reply.body.stream.content).not.toContain('�');expect(s.counts().triggers).toBe(1);
});
