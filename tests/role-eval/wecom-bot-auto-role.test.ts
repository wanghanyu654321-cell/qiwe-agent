import {afterEach,expect,it} from 'vitest';
import {mkdtempSync,readFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createBotConversations,pickAutoRole,type BotConversationReceipt} from '../../src/role-eval/wecom-bot-conversations.js';
import {createWecomBotContext} from '../../src/role-eval/wecom-bot-context.js';
import {BotTaskStore} from '../../src/role-eval/wecom-bot-task-store.js';
import {WorkbenchAccessStore,type WorkbenchRole} from '../../src/role-eval/workbench-access.js';

const cleanups:(()=>void)[]=[];afterEach(()=>{for(const fn of cleanups.splice(0).reverse())fn();});
function setup(granted:WorkbenchRole[],{bound=true}:{bound?:boolean}={}){
 const dir=mkdtempSync(join(tmpdir(),'auto-role-'));cleanups.push(()=>rmSync(dir,{recursive:true,force:true}));
 const grants=new WorkbenchAccessStore(join(dir,'grants.sqlite')),store=new BotTaskStore(join(dir,'facts.sqlite'));cleanups.push(()=>grants.close(),()=>store.close());
 grants.change('admin',{accountId:'a',storeId:'s',roles:granted,active:true,expectedVersion:0,requestKey:'grant'});
 const authority=createWecomBotContext({mode:'isolated-synthetic',tenantId:'t',stores:[{id:'s'}],roles:['marketing','ads','qa','reception'],store:grants,botId:'bot',corpId:'corp',readSubject:async()=>({botId:'bot',memberId:'member'}),
  readBinding:async()=>bound?{botId:'bot',corpId:'corp',memberId:'member',accountId:'a',version:1,active:true}:undefined as any,
  readNative:async()=>({user:{id:'a',role:'member',status:'active',must_change_password:false},workspaceJid:'web:home-a'})});cleanups.push(()=>authority.close());
 const prepared:string[]=[],submitted:{role:string;text:string}[]=[],receipts=new Map<string,BotConversationReceipt>();
 const native={readRoleWorkspace:async(input:any)=>{prepared.push(input.actor.role);return {state:'ready' as const,workspaceJid:'web:role-'+input.actor.role,profileId:'profile-'+input.actor.role,ownerAccountId:input.actor.accountId,storeId:input.actor.storeId,role:input.actor.role};},prepareRoleWorkspace:async()=>{throw Error('UNUSED');}};
 const intake={readReceipt:async(input:any)=>receipts.get(input.receiptId),submitMessage:async(input:any)=>{submitted.push({role:input.target.role,text:input.text});const r:BotConversationReceipt={receiptId:input.receiptId,messageId:input.originMessageId,acceptedAt:'2026-11-01',state:'accepted',role:input.target.role,workspaceJid:input.target.workspaceJid,profileId:input.target.profileId,selectionId:input.target.selectionId,fingerprint:input.fingerprint,execution:{state:'queued'}};receipts.set(r.receiptId,r);return r;}};
 const conversations=createBotConversations({store,native,intake,authority});
 const request=()=>({correlationId:'c',signal:new AbortController().signal,deadline:performance.now()+5000});
 let n=0;
 const send=async(text:string)=>{const scope=request(),context=await authority.authorize(scope,null);return conversations.route(context,{reqId:'r',botId:'bot',memberId:'member',messageId:'m'+(++n),createTime:n,action:{kind:'text',text}},scope);};
 return {send,prepared,submitted,store,authority,request};
}

it('auto-selects the single granted role and routes plain text to the model',async()=>{
 const s=setup(['marketing']);const reply=await s.send('帮我写一条周末活动文案');
 expect(s.submitted).toEqual([{role:'marketing',text:'帮我写一条周末活动文案'}]);
 expect(reply?.reply).toContain('收到，正在处理');expect(reply?.reply).not.toContain('可切换岗位');
 await s.send('再来一条');expect(s.submitted.map(x=>x.role)).toEqual(['marketing','marketing']);expect(new Set(s.prepared)).toEqual(new Set(['marketing']));
});
it('with several roles picks by content, falls back to the first, and hints how to switch',async()=>{
 const s=setup(['marketing','ads']);const reply=await s.send('这周投放预算怎么分配');
 expect(s.submitted[0]?.role).toBe('ads');expect(reply?.reply).toBe('收到，正在处理，稍后回复你。');
 const f=setup(['marketing','ads']);const fallback=await f.send('你好');
 // Fallback is marketing (the default role) whenever it is granted, regardless of grant order.
 expect(f.submitted[0]?.role).toBe('marketing');expect(fallback?.reply).not.toMatch(/岗位|[a-f0-9]{64}/);
 expect(pickAutoRole(['qa','reception'],'今天天气')).toEqual({role:'reception',multiple:true});
 expect(pickAutoRole(['manager'],'报数')).toBeUndefined();
});
it('manual 岗位 command still switches after auto selection',async()=>{
 const s=setup(['marketing','ads']);await s.send('你好');expect(s.submitted[0]?.role).toBe('marketing');
 expect((await s.send('岗位 投放辅助'))?.reply).toContain('投放辅助');await s.send('随便聊聊');expect(s.submitted[1]?.role).toBe('ads');
});
it('re-evaluates an auto selection per message, defaulting to reception, but keeps a manual choice',async()=>{
 const s=setup(['reception','marketing']);
 await s.send('你好');await s.send('帮我写个小红书文案');await s.send('顾客问营业时间');
 expect(s.submitted.map(x=>x.role)).toEqual(['reception','marketing','reception']);
 await s.send('岗位 内容营销');await s.send('顾客问营业时间');await s.send('你好');
 expect(s.submitted.slice(-2).map(x=>x.role)).toEqual(['marketing','marketing']);
});
it('denies an ungranted role and an unbound identity',async()=>{
 const s=setup(['marketing']);await expect(s.send('岗位 投放辅助')).rejects.toThrow('access_denied');
 expect(pickAutoRole(['marketing'],'投放预算')).toEqual({role:'marketing',multiple:false});
 await s.send('投放预算怎么分');expect(s.submitted.map(x=>x.role)).toEqual(['marketing']);
 const u=setup(['marketing'],{bound:false});await expect(u.send('你好')).rejects.toThrow();expect(u.submitted).toEqual([]);
});
it('gives the model the Front Claw identity line, without MiniClaw naming',async()=>{
 const fragment=readFileSync(new URL('../../integrations/native/conversation-execution-index.fragment',import.meta.url),'utf8');
 expect(fragment).toContain("const FRONT_CLAW_IDENTITY='你是 Front Claw，");expect(fragment).toContain('d3TerminalRunner(group,withFrontClawIdentity(input),');expect(fragment).not.toMatch(/MiniClaw/);
 const {FRONT_CLAW_IDENTITY}=await import('../../integrations/native/conversation-execution-overlay.mjs' as string);
 expect(FRONT_CLAW_IDENTITY.startsWith('你是 Front Claw，')).toBe(true);expect(fragment).toContain(FRONT_CLAW_IDENTITY);
 const overlay=readFileSync(new URL('../../integrations/native/conversation-execution-overlay.mjs',import.meta.url),'utf8');
 expect(overlay).toContain("'Failed to start Front Claw'");
});
