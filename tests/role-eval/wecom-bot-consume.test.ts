import {expect,it} from 'vitest';
import {ManagerStore} from '../../src/role-eval/manager-store.js';
import {WorkbenchAccessStore} from '../../src/role-eval/workbench-access.js';
import {createWecomBotContext} from '../../src/role-eval/wecom-bot-context.js';
import {createBotReportHandler} from '../../src/role-eval/wecom-bot-handler.js';
function setup(beforeWork?:Parameters<typeof createBotReportHandler>[0]['beforeWork']){const ledger=new ManagerStore(':memory:'),grants=new WorkbenchAccessStore(':memory:');grants.change('admin',{accountId:'a',storeId:'b',roles:['manager'],active:true,expectedVersion:0,requestKey:'open'});
 const authority=createWecomBotContext({mode:'isolated-synthetic',botId:'bot',corpId:'corp',tenantId:'t',stores:[{id:'b'}],roles:['manager'],store:grants,readSubject:async()=>({botId:'bot',memberId:'member'}),readBinding:async()=>({botId:'bot',corpId:'corp',memberId:'member',accountId:'a',version:1,active:true}),readNative:async()=>({user:{id:'a',role:'member',status:'active',must_change_password:false},workspaceJid:'web:home'})});
 const frame={cmd:'aibot_msg_callback',headers:{req_id:'req'},body:{aibotid:'bot',msgid:'m',chattype:'single',from:{userid:'member'},msgtype:'text',text:{content:'今天销售成交1.23元'}}};
 const actor={tenant:'t',store:'b',workspace:'web:ledger',employeeId:'e',employeeName:'合成员工'};
 const handler=createBotReportHandler({mode:'isolated-synthetic',authority,ledger,scope:{tenant:'t',store:'b',workspace:'web:ledger'},employees:[{accountId:'a',employeeId:'e',employeeName:'合成员工'}],readEvent:()=>frame,now:()=>new Date('2026-10-17T00:00:00Z'),...(beforeWork?{beforeWork}:{})});
 const request=()=>({correlationId:'consume',signal:new AbortController().signal,deadline:performance.now()+1000});return {ledger,grants,authority,handler,frame,actor,request,close(){authority.close();ledger.close();grants.close();}};
}
it('only consumes a factory issued result and keeps its original reply and recipient private',async()=>{const s=setup();try{const r=await s.handler.handle(s.request());r.reply.body.stream.content='forged-content';s.frame.body.from.userid='other';let calls=0;
 await expect(s.handler.consumeReply({...r},async()=>++calls)).rejects.toThrow('access_denied');
 const value=await s.handler.consumeReply(r,async value=>{calls++;expect(value.event.memberId).toBe('member');expect(value.result.reply.body.stream.content).toContain('1.23元');expect(value.result.reply.body.stream.content).not.toContain('forged-content');value.result.reply.body.stream.content='port-mutation';return 'accepted';});expect(value).toBe('accepted');
 await s.handler.consumeReply(r,async value=>{expect(value.result.reply.body.stream.content).not.toContain('port-mutation');});expect(calls).toBe(1);
 }finally{s.close();}});
it('rechecks revocation before consuming a prior result',async()=>{const s=setup();try{const r=await s.handler.handle(s.request());s.grants.change('admin',{accountId:'a',storeId:'b',roles:['manager'],active:false,expectedVersion:1,requestKey:'revoke'});let calls=0;await expect(s.handler.consumeReply(r,async()=>calls++)).rejects.toThrow('access_changed');expect(calls).toBe(0);}finally{s.close();}});
it('loads only the original owned bot recipient for recovery without a callback req_id',async()=>{const s=setup();try{const p=await s.handler.handle(s.request()),r=s.ledger.getReport(s.actor,p.reportId!)!;s.ledger.confirm(s.actor,r.id,r.hash,r.proposed.items);
 expect(await s.handler.consumeReport(s.request(),r.id,async value=>({member:value.report.botSource!.memberId,amount:value.report.entries[0]!.amountCents}))).toEqual({member:'member',amount:123});
 await expect(s.handler.consumeReport(s.request(),'f'.repeat(64),async()=>true)).rejects.toThrow('report_not_found');
 }finally{s.close();}});
it('does not let a reservation provider mutate the verified event, actor or reply recipient',async()=>{
 let calls=0;const s=setup(value=>{calls++;Reflect.set(value.actor,'employeeId','other');Reflect.set(value.event,'memberId','other');Reflect.set(value.event.action,'text','今天销售成交999元');});
 try{const result=await s.handler.handle(s.request());expect(calls).toBe(1);expect(s.ledger.getReport(s.actor,result.reportId!)?.proposed.items[0]?.amountCents).toBe(123);await s.handler.consumeReply(result,async value=>{expect(value.event.memberId).toBe('member');expect(value.actor.employeeId).toBe('e');});}finally{s.close();}
});
