import {it,expect} from 'vitest';import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import {createHash} from 'node:crypto';
import {createTrainingSummaryService} from '../../src/role-eval/training-knowledge.js';
import {createTrainingGenerationService,type TrainingContext} from '../../src/role-eval/training-generation.js';
const scope={accountId:'owner',workspaceJid:'web:local-training'},input={requestKey:'synthetic-1',mode:'question',query:'家访 五步法',persona:'instructor'};
function setup(){const dir=fs.mkdtempSync(path.join(os.tmpdir(),'training-run-')),body='# 合成家访资料\n\n## 家访五步法\n先访谈，再安排演练和复盘。',hash=createHash('sha256').update(body).digest('hex');fs.writeFileSync(path.join(dir,'approval.json'),JSON.stringify({kind:'user_provided_summary',scope,sha256:hash,fileName:'test.md'}));fs.writeFileSync(path.join(dir,'summary-'+hash+'.json'),JSON.stringify({scope,sha256:hash,sourceText:body}));return {dir,knowledge:createTrainingSummaryService(dir,scope)};}
const answer=(id:string)=>({answer:'先访谈，再演练；这是建议，不代表已完成培训。',lesson:null,citations:[id],limitations:['仅合成教学练习，需人工审核。']});
it('persists generated answers with source citations and reuses the original request after restart',async()=>{
 const {dir,knowledge}=setup();let calls=0;const service=createTrainingGenerationService({dir:path.join(dir,'runs'),scope,knowledge,generate:async context=>{calls++;return answer(context.sources[0]!.id);}});
 const started=service.start(scope,input);expect(started.status).toBe('running');await service.settled(input.requestKey);
 const result=service.get(scope,input.requestKey);expect(result.status).toBe('ready');expect(result.output?.answer).toContain('访谈');expect(result.sources).toHaveLength(1);
 expect(service.start(scope,input).id).toBe(started.id);expect(calls).toBe(1);
 const restored=createTrainingGenerationService({dir:path.join(dir,'runs'),scope,knowledge,generate:async()=>{throw Error('must not repeat');}});expect(restored.get(scope,input.requestKey)).toEqual(result);
});
it('rejects forged identity, invalid mode, changed duplicate and fabricated citations',async()=>{
 const {dir,knowledge}=setup();const service=createTrainingGenerationService({dir:path.join(dir,'runs'),scope,knowledge,generate:async()=>answer('invented')});
 expect(()=>service.start({...scope,accountId:'other'},input)).toThrow('training_scope_denied');expect(()=>service.start(scope,{...input,store:'b'})).toThrow('invalid_training_generation');
 service.start(scope,input);expect(()=>service.start(scope,{...input,query:'changed'})).toThrow('training_request_conflict');await service.settled(input.requestKey);expect(service.get(scope,input.requestKey).status).toBe('failed');expect(service.get(scope,input.requestKey).output).toBeNull();
});
it('keeps missing evidence and revoked sources out of generated answers',async()=>{
 const {dir,knowledge}=setup();let calls=0,finish:(v:unknown)=>void=()=>{};const service=createTrainingGenerationService({dir:path.join(dir,'runs'),scope,knowledge,generate:async()=>{calls++;return new Promise(r=>finish=r);}});
 expect(()=>service.start(scope,{...input,query:'999班 原始大单总结'})).toThrow('training_evidence_missing');expect(calls).toBe(0);
 service.start(scope,input);fs.unlinkSync(path.join(dir,'approval.json'));finish(answer('unused'));await service.settled(input.requestKey);expect(service.get(scope,input.requestKey).status).toBe('stale');expect(service.get(scope,input.requestKey).output).toBeNull();
});
it('an unsettled request after process restart is unknown and is never silently replayed',async()=>{
 const {dir,knowledge}=setup();const service=createTrainingGenerationService({dir:path.join(dir,'runs'),scope,knowledge,generate:async()=>new Promise(()=>{})});service.start(scope,input);
 const fresh=createTrainingGenerationService({dir:path.join(dir,'runs'),scope,knowledge,generate:async()=>{throw Error('must not replay');}});expect(fresh.get(scope,input.requestKey).status).toBe('unknown');expect(fresh.start(scope,input).status).toBe('unknown');
});

const lesson=(id:string)=>({answer:'合成45分钟家访教案，尚未执行培训。',lesson:{title:'家访五步法练习',goals:['能够说明访谈与复盘步骤'],
 steps:[{minutes:10,activity:'阅读批准段落',practice:'复述访谈顺序',evidence:'保留复述记录'},{minutes:20,activity:'情景演练',practice:'两人模拟访谈',evidence:'填写观察表'},{minutes:15,activity:'复盘反馈',practice:'提出一项改进',evidence:'形成改进行动'}],
 assessment:['依照批准段落核对访谈顺序'],followUp:['下一次演练前复核改进行动']},citations:[id],limitations:['仅合成教学练习，需人工审核。']});

it('persists a complete cited 45-minute lesson through the original service and reads it without regeneration',async()=>{
 const {dir,knowledge}=setup();let calls=0;
 const service=createTrainingGenerationService({dir:path.join(dir,'runs'),scope,knowledge,generate:async context=>{calls++;return lesson(context.sources[0]!.id);}});
 const request={...input,requestKey:'lesson-complete',mode:'lesson'};
 const started=service.start(scope,request);await service.settled(request.requestKey);const result=service.get(scope,request.requestKey);
 expect(result).toMatchObject({id:started.id,status:'ready',error:null,input:request,output:lesson(result.sources[0]!.id)});
 const output=result.output!.lesson!;expect(output.steps.reduce((total,step)=>total+step.minutes,0)).toBe(45);
 expect(output.steps.every(step=>step.practice.length>0&&step.evidence.length>0)).toBe(true);expect(output.assessment.length).toBeGreaterThan(0);expect(output.followUp.length).toBeGreaterThan(0);
 expect(result.output!.citations).toEqual([result.sources[0]!.id]);expect(calls).toBe(1);
 const reader=createTrainingGenerationService({dir:path.join(dir,'runs'),scope,knowledge,generate:async()=>{calls++;throw Error('must not regenerate a saved lesson');}});
 expect(reader.get(scope,request.requestKey)).toEqual(result);expect(reader.start(scope,request)).toEqual(result);expect(calls).toBe(1);
});

it.each([
 ['training_model_disabled','training_model_disabled'],
 ['training_budget_exhausted','training_budget_exhausted'],
 ['synthetic-private-provider-token=do-not-publish','training_model_unavailable'],
])('persists sanitized generator failure %s and never reruns the same request',async(message,publicCode)=>{
 const {dir,knowledge}=setup();let calls=0;
 const generate=async()=>{calls++;throw Error(message);};
 const service=createTrainingGenerationService({dir:path.join(dir,'runs'),scope,knowledge,generate});
 const started=service.start(scope,input);await service.settled(input.requestKey);const result=service.get(scope,input.requestKey);
 expect(result).toMatchObject({id:started.id,status:'failed',output:null,error:publicCode});expect(result.sources.length).toBeGreaterThan(0);
 expect(service.start(scope,input)).toEqual(result);expect(calls).toBe(1);
 const reader=createTrainingGenerationService({dir:path.join(dir,'runs'),scope,knowledge,generate});
 expect(reader.get(scope,input.requestKey)).toEqual(result);expect(reader.start(scope,input)).toEqual(result);expect(calls).toBe(1);
 const saved=fs.readdirSync(path.join(dir,'runs')).filter(name=>name.endsWith('.json')).map(name=>fs.readFileSync(path.join(dir,'runs',name),'utf8')).join('');
 if(publicCode==='training_model_unavailable'){expect(JSON.stringify(result)).not.toContain(message);expect(saved).not.toContain(message);}
 expect(saved).toContain(publicCode);
});

it.each(['duration','citation','practice'] as const)('rejects an invalid %s lesson at the service publication boundary and retains the failed result',async(invalid)=>{
 const {dir,knowledge}=setup();let calls=0;
 const generate=async(context:TrainingContext)=>{
  calls++;const output=lesson(context.sources[0]!.id);
  if(invalid==='duration')output.lesson.steps[0]!.minutes=9;
  else if(invalid==='citation')output.citations=['fabricated-source'];
  else output.lesson.steps[0]!.practice='';
  return output;
 };
 const service=createTrainingGenerationService({dir:path.join(dir,'runs'),scope,knowledge,generate});
 const request={...input,requestKey:'invalid-lesson-'+invalid,mode:'lesson'};
 const started=service.start(scope,request);await service.settled(request.requestKey);const result=service.get(scope,request.requestKey);
 expect(result).toMatchObject({id:started.id,status:'failed',error:'training_output_unverified',output:null});
 expect(service.start(scope,request)).toEqual(result);expect(calls).toBe(1);
 const reader=createTrainingGenerationService({dir:path.join(dir,'runs'),scope,knowledge,generate});
 expect(reader.get(scope,request.requestKey)).toEqual(result);expect(reader.start(scope,request)).toEqual(result);expect(calls).toBe(1);
});
