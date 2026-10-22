import {expect,it} from 'vitest';
import {createHash} from 'node:crypto';
import {addBotConversationReceipts,createBotConversationNativePort} from './conversation-overlay.mjs';

const source=`export const CURRENT_SCHEMA_VERSION = 69;
export function initDatabase(){db.exec(\`
    CREATE INDEX IF NOT EXISTS idx_messages_jid_ts ON messages(chat_jid, timestamp);\`)}
export function storeMessageDirect(){}`;
const actor={tenantId:'tenant',accountId:'owner',storeId:'store',corpId:'corp',botId:'bot',memberId:'member',bindingVersion:1,grantVersion:1};
const scope=()=>({signal:new AbortController().signal,deadline:performance.now()+1000,correlationId:'synthetic'});
const receiptId=createHash('sha256').update(JSON.stringify(['corp','bot','member','origin'])).digest('hex');
const request=(overrides:any={})=>({actor,roles:['marketing'],receiptId,originMessageId:'origin',fingerprint:'fingerprint',text:'Hello',target:{workspaceJid:'web:role',profileId:'profile',role:'marketing',selectionId:'selection'},scope:scope(),assertCurrent:async()=>{},withCurrent:async(work:()=>unknown)=>work(),...overrides});

it('composes explicit receipt table into original schema upgrade and keeps original persistence calls',()=>{
 const result=addBotConversationReceipts(source);
 expect(result).toContain('CURRENT_SCHEMA_VERSION = 70');
 expect(result).toContain('CREATE TABLE IF NOT EXISTS wecom_conversation_receipts');
 expect(result).toContain('storeMessageDirect(messageId, input.target.workspaceJid');
 expect(result).toContain('ensureChatExists(input.target.workspaceJid)');
 expect(result).toContain('db.transaction(() =>');
});

it('denies a closed gate before reading actor or native state',async()=>{
 let calls=0;
 const gate={isPaused:()=>true,beginWrite:()=>{calls++;return null},finishWrite:()=>{calls++}};
 const port=createBotConversationNativePort({mode:'isolated-synthetic',gate,native:{readBotConversationReceipt:()=>{calls++},submitBotConversationMessage:()=>{calls++}},readActor:async()=>{calls++}});
 await expect(port.readReceipt(request())).rejects.toThrow('CONVERSATION_MAINTENANCE');
 await expect(port.submitMessage(request())).rejects.toThrow('CONVERSATION_MAINTENANCE');
 expect(calls).toBe(0);
});

it('freezes startup callbacks and retains gate ticket through delayed authority, then refuses revoked commit',async()=>{
 let resume:(value:any)=>void=()=>{},finishes=0,writes=0;
 const gate={isPaused:()=>false,beginWrite:()=>Symbol('ticket'),finishWrite:()=>{finishes++}};
 const native={getUserById:()=>({id:actor.accountId,role:'member',status:'active',must_change_password:false}),readBotConversationReceipt:()=>{writes++;return undefined},submitBotConversationMessage:()=>{writes++;throw Error('unexpected')}};
 const options={mode:'isolated-synthetic',gate,native,readActor:()=>new Promise(resolve=>{resume=resolve})};
 const port=createBotConversationNativePort(options);
 options.readActor=async()=>({...actor});native.readBotConversationReceipt=()=>{writes++;throw Error('mutated')};
 let revoked=false;
 const input=request({withCurrent:async(work:()=>unknown)=>{if(revoked)throw Error('access_changed');return work()}});
 const pending=port.readReceipt(input);
 await Promise.resolve();expect(finishes).toBe(0);
 revoked=true;resume({...actor});
 await expect(pending).rejects.toThrow('access_changed');
 expect(finishes).toBe(1);expect(writes).toBe(0);
});
