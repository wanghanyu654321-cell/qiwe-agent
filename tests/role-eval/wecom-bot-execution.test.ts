import {it,expect} from 'vitest';
import {WorkbenchAccessStore} from '../../src/role-eval/workbench-access.js';
import {createWecomBotContext} from '../../src/role-eval/wecom-bot-context.js';

function setup(){
  const store=new WorkbenchAccessStore(':memory:');
  store.change('admin',{accountId:'a',storeId:'b',roles:['manager'],active:true,expectedVersion:0,requestKey:'open'});
  const user={id:'a',role:'member',status:'active',must_change_password:false};
  const api=createWecomBotContext({mode:'isolated-synthetic',botId:'bot',corpId:'corp',tenantId:'tenant',stores:[{id:'b'}],roles:['manager'],store,
    readSubject:async()=>({botId:'bot',memberId:'member-a'}),
    readBinding:async()=>({botId:'bot',corpId:'corp',memberId:'member-a',accountId:'a',version:3,active:true}),
    readNative:async()=>({user,workspaceJid:'web:home-a'}),
  });
  const request=()=>({correlationId:'execution',signal:new AbortController().signal,deadline:performance.now()+1000});
  return {store,user,api,request,close(){api.close();store.close();}};
}

it('exposes the authenticated channel identity without accepting event-supplied account or store',async()=>{
  const s=setup();try{
    const context=await s.api.authorize(s.request(),'manager');
    expect(context.channel).toEqual({botId:'bot',corpId:'corp',memberId:'member-a',bindingVersion:3});
    expect(Object.isFrozen(context.channel)).toBe(true);
  }finally{s.close();}
});

it('refuses business callbacks for copied contexts and grants revoked after an initial authorization',async()=>{
  const s=setup();try{
    const context=await s.api.authorize(s.request(),'manager');let writes=0;
    await expect(s.api.withCurrent({...context},()=>++writes)).rejects.toThrow('access_denied');
    s.store.change('admin',{accountId:'a',storeId:'b',roles:['manager'],active:false,expectedVersion:1,requestKey:'revoke'});
    await expect(s.api.withCurrent(context,()=>++writes)).rejects.toThrow('access_changed');
    expect(writes).toBe(0);
  }finally{s.close();}
});

it('rechecks Native disable and cancellation before a synchronous commit',async()=>{
  const s=setup();try{
    const controller=new AbortController();const context=await s.api.authorize({...s.request(),signal:controller.signal},'manager');let writes=0;
    s.user.status='disabled';await expect(s.api.withCurrent(context,()=>++writes)).rejects.toThrow('access_changed');
    s.user.status='active';controller.abort();await expect(s.api.withCurrent(context,()=>++writes)).rejects.toThrow('authority_cancelled');
    expect(writes).toBe(0);
  }finally{s.close();}
});

it('returns the original synchronous result while serializing with the existing grant store',async()=>{
  const s=setup();try{
    const context=await s.api.authorize(s.request(),'manager');
    expect(await s.api.withCurrent(context,()=>({reportId:'same-result',amountCents:12345}))).toEqual({reportId:'same-result',amountCents:12345});
  }finally{s.close();}
});
