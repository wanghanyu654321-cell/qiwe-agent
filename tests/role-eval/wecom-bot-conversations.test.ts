import {afterEach,expect,it} from 'vitest';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {BotTaskStore} from '../../src/role-eval/wecom-bot-task-store.js';
import {parseBotConversationCommand} from '../../src/role-eval/wecom-bot-conversations.js';

const opened:{store:BotTaskStore;dir:string}[]=[];
afterEach(()=>{for(const item of opened.splice(0))item.store.close();for(const dir of new Set(openedDirs.splice(0)))rmSync(dir,{recursive:true,force:true});});
const openedDirs:string[]=[];
function open(){const dir=mkdtempSync(path.join(tmpdir(),'wecom-conversation-'));openedDirs.push(dir);const store=new BotTaskStore(path.join(dir,'facts.sqlite'));opened.push({store,dir});return {store,file:path.join(dir,'facts.sqlite')};}
const actor={tenantId:'tenant',storeId:'store-a',accountId:'person-a',corpId:'corp',botId:'bot',memberId:'member-a',bindingVersion:1,grantVersion:1};
const event=(messageId:string,role:'marketing'|'qa'='marketing')=>({messageId,fingerprint:'a'.repeat(64),actor,role});

it('parses selection and exit without consuming original task and reporting commands',()=>{
 expect(parseBotConversationCommand('岗位 内容营销')).toEqual({kind:'select',role:'marketing'});
 expect(parseBotConversationCommand('退出岗位对话')).toEqual({kind:'exit'});
 expect(parseBotConversationCommand('岗位查询')).toEqual({kind:'status'});
 expect(parseBotConversationCommand('岗位 不存在')).toEqual({kind:'invalid'});
 expect(parseBotConversationCommand('执行任务 内容营销 weekly')).toBeUndefined();
 expect(parseBotConversationCommand('报数 本月销售100元')).toBeUndefined();
});
it('persists the selected non-Home workspace across connections and does not replay an older event over a newer role',()=>{
 const {store,file}=open();const first=store.beginConversationSelection(event('first'));
 expect(first.state).toBe('preparing');
 store.finishConversationSelection(event('first'),{workspaceJid:'web:marketing-a',profileId:'profile-marketing'});
 const second=new BotTaskStore(file);opened.push({store:second,dir:path.dirname(file)});
 expect(second.currentConversation(actor)).toMatchObject({role:'marketing',workspaceJid:'web:marketing-a',profileId:'profile-marketing',state:'ready'});
 store.beginConversationSelection(event('second','qa'));
 store.finishConversationSelection(event('second','qa'),{workspaceJid:'web:qa-a',profileId:'profile-qa'});
 expect(second.beginConversationSelection(event('first')).role).toBe('marketing');
 expect(second.currentConversation(actor)).toMatchObject({role:'qa',workspaceJid:'web:qa-a'});
});
it('rejects remapped event payload, prevents stale grant or binding from becoming a fresh default, and exits only the current scope',()=>{
 const {store}=open();store.beginConversationSelection(event('first'));
 store.finishConversationSelection(event('first'),{workspaceJid:'web:marketing-a',profileId:'profile-marketing'});
 expect(()=>store.beginConversationSelection({...event('first'),actor:{...actor,storeId:'store-b'}})).toThrow('conversation_conflict');
 expect(store.currentConversation({...actor,grantVersion:2})).toMatchObject({state:'stale'});
 expect(store.currentConversation({...actor,bindingVersion:2})).toMatchObject({state:'stale'});
 expect(store.exitConversation(actor,'exit','b'.repeat(64)).state).toBe('exited');
 expect(store.currentConversation(actor)).toBeUndefined();
 expect(store.exitConversation(actor,'exit','b'.repeat(64)).state).toBe('exited');
 expect(()=>store.exitConversation({...actor,storeId:'store-b'},'exit','b'.repeat(64))).toThrow('conversation_conflict');
});
