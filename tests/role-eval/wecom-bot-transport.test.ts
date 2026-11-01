import {expect,it} from 'vitest';
import {normalizeBotFrame} from '../../src/role-eval/wecom-bot-transport.js';
const id='a'.repeat(64),hash='b'.repeat(64);
const text=()=>({cmd:'aibot_msg_callback',headers:{req_id:'req-1'},body:{aibotid:'bot',msgid:'message',chattype:'single',from:{userid:'member'},msgtype:'text',text:{content:'今天销售成交12.34元'}}});
it('normalizes official text frames without granting client authority',()=>{
 const frame=text();Object.assign(frame.body,{accountId:'admin',storeId:'elsewhere',roles:['manager']});
 expect(normalizeBotFrame(frame)).toEqual({reqId:'req-1',botId:'bot',memberId:'member',messageId:'message',action:{kind:'text',text:'今天销售成交12.34元'}});
});
it('reads only official template card task and event keys',()=>{
 expect(normalizeBotFrame({cmd:'aibot_event_callback',headers:{req_id:'event'},body:{aibotid:'bot',msgid:'card',create_time:1792224000,chattype:'single',from:{userid:'member',corpid:'corp'},msgtype:'event',event:{eventtype:'template_card_event',task_id:'report-'+id+'-'+'c'.repeat(32),event_key:'confirm:'+hash,amountCents:999}}})).toMatchObject({action:{kind:'confirm',reportId:id,hash},createTime:1792224000,corpId:'corp'});
});
it.each(['group',undefined])('rejects group or ambiguous chat type %s',type=>{const frame=text();Object.assign(frame.body,{chattype:type});expect(()=>normalizeBotFrame(frame)).toThrow('unsupported_event');});
it.each([NaN,-1,1.5,Number.MAX_SAFE_INTEGER])('rejects unusable timestamp %s',create_time=>{const frame=text();Object.assign(frame.body,{create_time});expect(()=>normalizeBotFrame(frame)).toThrow('unsupported_event');});
it('rejects wrong command, malformed body and overlong text',()=>{
 for(const frame of [{...text(),cmd:'request'},null,{...text(),body:{...text().body,text:{content:'x'.repeat(4001)}}}])expect(()=>normalizeBotFrame(frame)).toThrow('unsupported_event');
});
it('does not accept forged confirmation actions on a text callback',()=>{
 const frame=text();Object.assign(frame.body,{msgtype:'event',event:{eventtype:'template_card_event',task_id:'report-'+id+'-'+'c'.repeat(32),event_key:'confirm:'+hash}});
 expect(()=>normalizeBotFrame(frame)).toThrow('unsupported_event');
});
it('accepts the task_id alphabet required by the official SDK contract',()=>{
 expect(normalizeBotFrame({cmd:'aibot_event_callback',headers:{req_id:'event'},body:{aibotid:'bot',msgid:'card',chattype:'single',from:{userid:'member'},msgtype:'event',event:{eventtype:'template_card_event',task_id:'report-'+id+'-'+'c'.repeat(32),event_key:'confirm:'+hash}}})).toMatchObject({action:{kind:'confirm',reportId:id,hash}});
});
