import {expect} from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import {actor,workspaceJid,folder,receiptId} from './full-host-restoration.fixture.mts';
import {skillIds} from './full-host-restoration-pi.fixture.mts';

/** One restored employee assembly, one original main/queue/DB, two OS phases. */
export async function exerciseRestorationPiScenario({host,db,sql,config,boundary,transportCalls,pi,send,reply,offline,completedDeliveries,events,restarting}:any){
 const marker=path.resolve('restoration-pi-results.json');
 const origins=['first','follow-up','queued-cancel','active-cancel','successor'];
 const id=(name:string)=>receiptId('restoration-pi-'+name);
 const state=(name:string)=>db.readConversationExecution(id(name));
 const escaped=(text:string)=>JSON.stringify(text).slice(1,-1);
 const input=async(name:string,text:string)=>send('restoration-pi-'+name,`[pi-${name}] ${text}`);
 let querySequence=0;const queryOrigins=new Map<string,string>();
 const query=async(name:string,retryPrevious=false)=>{
  const origin=retryPrevious?queryOrigins.get(name)!:(restarting?'restart':'boot')+'-pi-query-'+name+'-'+(++querySequence);
  expect(origin).toBeTruthy();queryOrigins.set(name,origin);
  return JSON.stringify(reply(await send(origin,'查询对话 '+id(name))));
 };
 const idle=()=>boundary.wait(()=>!host.fullHostQueue.hasDirectActiveRunner(workspaceJid),'original runner transport has settled');
 if(restarting){
  const saved=JSON.parse(fs.readFileSync(marker,'utf8'));expect(saved.processId).not.toBe(process.pid);
  for(const item of saved.receipts){
   expect(db.readConversationExecution(item.receiptId)).toEqual(item.execution);
   expect(db.readConversationResults(item.receiptId)).toEqual(item.results);
   const answer=await query(item.name);
   expect(answer).toContain(item.results.length?escaped(item.results[0].content):'已取消');
  }
  expect(transportCalls).toEqual([]);expect(pi.requests).toEqual([]);expect(completedDeliveries).toEqual([]);
  expect(offline.sent.filter((frame:any)=>frame.cmd==='aibot_send_msg')).toEqual([]);
  events.push('same-saved-host-new-process-original-Pi-results-and-cancellations-query-without-reseed-rerun-resend');
  return {firstProcessId:saved.processId,receipts:saved.receipts,runnerCalls:0,modelCalls:0,proactiveResends:0};
 }
 await input('first','请读取已批准资料，结合内容策划与文案方法，给出尚未发布的活动草稿。');
 await boundary.wait(()=>pi.requests.length===1,'first original SDK request reached held provider seam');
 expect(state('first')).toMatchObject({state:'running',queryId:transportCalls[0].queryRunId,turnId:transportCalls[0].turnId});
 await input('follow-up','沿用上一条草稿和已批准人数，把行动号召调整得更清楚，并继续保留未发布状态。');
 expect(state('follow-up')?.state).toBe('queued');expect(transportCalls).toHaveLength(1);
 pi.release('first');
 await boundary.wait(()=>state('first')?.state!=='running','first Pi turn settled after graceful drain');
 expect(state('first')?.state,'queue drain must preserve the active answer').toBe('completed');
 await boundary.wait(()=>state('follow-up')?.state==='completed','queued follow-up completed through original Pi');
 await boundary.wait(()=>completedDeliveries.length===2,'distinct D5 notifications settled');await idle();
 expect(transportCalls).toHaveLength(2);
 const first=db.readConversationResults(id('first'))[0],follow=db.readConversationResults(id('follow-up'))[0];
 expect(first).toBeDefined();expect(follow).toBeDefined();
 expect(state('first').sessionId).toBeTruthy();
 // Preserved unknown legacy turns make the original history policy rebuild.
 // Honor that policy; do not discard old rows merely to manufacture reuse.
 const sessionReused=transportCalls[1].sessionId===state('first').sessionId;
 if(sessionReused)expect(state('follow-up').sessionId).toBe(state('first').sessionId);
 else{expect(transportCalls[1].sessionId).toBeUndefined();expect(state('follow-up').sessionId).not.toBe(state('first').sessionId);}
 expect(first.receiptId).not.toBe(follow.receiptId);expect(first.queryId).not.toBe(follow.queryId);expect(first.turnId).not.toBe(follow.turnId);
 for(const [name,result] of [['first',first],['follow-up',follow]] as const){
  expect(result).toMatchObject({receiptId:id(name),revision:1,queryId:state(name).queryId,turnId:state(name).turnId});
  expect(JSON.parse(result.content)).toMatchObject({status:'draft',executed:false,published:false,request:name,draft:{evidence:'synthetic-approved-v1',methods:[{source:'vendor-content-strategy/SKILL.md'},{source:'vendor-copywriting/SKILL.md'}]}});
  const canonical=sql.prepare('SELECT * FROM messages WHERE id=? AND chat_jid=?').get(result.sourceOutputIds[0],workspaceJid);
  expect(canonical).toMatchObject({content:result.content,turn_id:result.turnId,is_from_me:1});
  const note=offline.sent.filter((frame:any)=>frame.cmd==='aibot_send_msg'&&JSON.stringify(frame).includes(id(name)));
  expect(note).toHaveLength(1);expect(note[0].body).toMatchObject({chatid:actor.memberId,chat_type:1,msgtype:'markdown'});
  expect(JSON.stringify(note[0])).toContain(escaped(result.content));
  expect(await query(name)).toContain(escaped(result.content));
 }
 const firstRequests=pi.requests.filter((request:any)=>request.turnId===first.turnId);
 for(const skill of skillIds)expect(firstRequests[0].systemPrompt).toContain(skill);
 const observations=firstRequests.at(-1).messages.filter((message:any)=>message.role==='toolResult');
 expect(observations.map((message:any)=>message.toolName)).toEqual(['read','read','read','read','mcp__miniclaw__get_channel_context']);
 expect(observations.every((message:any)=>!message.isError)).toBe(true);
 expect(JSON.stringify(observations)).toContain('主题对应到可展示的服务步骤');expect(JSON.stringify(observations)).toContain('单一行动号召');
 const followFirst=pi.requests.find((request:any)=>request.turnId===follow.turnId);
 const {escapeXml}=await import('../src/message-prompt.js');
 expect(followFirst.messages.some((message:any)=>Array.isArray(message.content)&&message.content.some((part:any)=>typeof part.text==='string'&&(part.text.includes(first.content)||part.text.includes(escapeXml(first.content)))))).toBe(true);
 for(const unknown of ['Synthetic old running','Synthetic old queued','Synthetic Q unknown reply'])expect(JSON.stringify(followFirst.messages)).not.toContain(unknown);
 events.push('original-Profile-inherit-three-pinned-skills-runTurn-SDK-read-context-two-methods-frozen-draft');
 events.push('running-follow-up-queued-distinct-receipt-query-turn-result-original-session-policy-prior-answer-visible');

 await input('active-cancel','请继续准备这条待取消的草稿，不要发布。');
 await boundary.wait(()=>pi.runs.length===3&&pi.requests.some((request:any)=>request.turnId===pi.runs[2].input.turnId),'cancellable original SDK provider started');
 await input('queued-cancel','这是排队后应取消的需求，不得执行。');expect(state('queued-cancel')?.state).toBe('queued');
 await input('successor','请保留这条独立后续需求，使用批准资料生成未发布草稿。');expect(state('successor')?.state).toBe('queued');
 await send('pi-cancel-queued','取消对话 '+id('queued-cancel'));expect(state('queued-cancel')?.state).toBe('cancelled');
 await send('pi-cancel-active','取消对话 '+id('active-cancel'));expect(state('active-cancel')?.state).toBe('cancelling');
 const pendingCancellationReply=await query('active-cancel');expect(pendingCancellationReply).toContain('取消处理中');
 await boundary.wait(()=>pi.runs[2].providerAborted,'original queue sentinel caused real SDK AbortSignal');
 expect(state('active-cancel')?.state).toBe('cancelling');expect(db.readConversationResults(id('active-cancel'))).toEqual([]);
 pi.release('active-cancel');
 await boundary.wait(()=>pi.runs[2].interrupted,'original runTurn actually finished its interrupted turn');
 await boundary.wait(()=>state('active-cancel')?.state!=='cancelling','D3 settles only after actual original interruption');
 console.log('RESTORATION_PI_CANCELLATION',JSON.stringify({execution:state('active-cancel'),providerAborted:pi.runs[2].providerAborted,runTurnInterrupted:pi.runs[2].interrupted,outputs:pi.runs[2].outputs.map((output:any)=>({status:output.status,turnId:output.turnId,inputTurnId:output.inputTurnId,streamEvent:output.streamEvent}))}));
 expect(state('active-cancel')?.state,'actual Pi abort must become an exact D3 cancellation, not an unknown result').toBe('cancelled');
 await boundary.wait(()=>pi.runs.length===4&&pi.requests.some((request:any)=>request.turnId===pi.runs[3].input.turnId),'unrelated pending successor remains executable');
 expect(pi.runs[3].kind).toBe('successor');expect(state('successor')?.state).toBe('running');
 const activeRun=pi.runs[2],successorRun=pi.runs[3];
 await send('pi-repeat-old-cancel','取消对话 '+id('active-cancel'));
 expect(state('successor')?.state).toBe('running');expect(successorRun.providerAborted).toBe(false);
 expect(fs.existsSync(path.join(config.DATA_DIR,'ipc',folder,'input','_interrupt'))).toBe(false);
 await activeRun.onOutput({status:'stream',result:null,turnId:activeRun.input.turnId,streamEvent:{eventType:'status',statusText:'interrupted',turnId:activeRun.input.turnId}});
 await activeRun.onOutput({status:'success',result:'LATE_CANCELLED_OUTPUT_MUST_NOT_PUBLISH',turnId:activeRun.input.turnId,inputTurnId:activeRun.input.turnId,inputTurnCompleted:true,sourceKind:'sdk_final',finalizationReason:'completed'});
 expect(state('successor')?.state).toBe('running');expect(db.readConversationResults(id('active-cancel'))).toEqual([]);
 expect(sql.prepare('SELECT count(*) AS n FROM messages WHERE content=?').get('LATE_CANCELLED_OUTPUT_MUST_NOT_PUBLISH')).toEqual({n:0});
 pi.release('successor');await boundary.wait(()=>state('successor')?.state==='completed','successor completes after old cancellation and stale events');
 await boundary.wait(()=>completedDeliveries.length===3,'successor alone adds completion delivery');await idle();
 expect(transportCalls).toHaveLength(4);expect(pi.runs.map((run:any)=>run.kind)).toEqual(['first','follow-up','active-cancel','successor']);
 // A replay of the same callback keeps its original reply; a new employee
 // query gets the newly committed status through a distinct message identity.
 expect(await query('active-cancel',true)).toBe(pendingCancellationReply);
 for(const name of ['queued-cancel','active-cancel']){expect(await query(name)).toContain('已取消');expect(db.readConversationResults(id(name))).toEqual([]);}
 for(const frame of offline.sent)expect(JSON.stringify(frame)).not.toContain('LATE_CANCELLED_OUTPUT_MUST_NOT_PUBLISH');
 expect(offline.sent.filter((frame:any)=>frame.cmd==='aibot_send_msg')).toHaveLength(3);
 const receipts=origins.map(name=>({name,receiptId:id(name),execution:state(name),results:db.readConversationResults(id(name))}));
 const evidence={processId:process.pid,receipts,modelCalls:pi.requests.length,skills:skillIds,observedTools:observations.map((message:any)=>({name:message.toolName,callId:message.toolCallId,isError:message.isError??false})),priorSdkAnswerVisible:true,sessionPolicy:sessionReused?'original-session-reused':'original-legacy-history-policy-rebuilt-session',runs:pi.runs.map(({input,kind,providerAborted,interrupted,closed}:any)=>({queryId:input.queryRunId,turnId:input.turnId,inputSessionId:input.sessionId,kind,providerAborted,interrupted,closed}))};
 fs.writeFileSync(marker,JSON.stringify(evidence,null,2));
 events.push('exact-queued-cancel-no-run-active-cancelling-original-sentinel-SDK-abort-cancelled-stale-events-fenced-successor-completes');
 return evidence;
}
