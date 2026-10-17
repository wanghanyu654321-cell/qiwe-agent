import {it,expect} from 'vitest';import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import {createHash} from 'node:crypto';
import {createTrainingSummaryService} from '../../src/role-eval/training-knowledge.js';
import {createTrainingGenerationService} from '../../src/role-eval/training-generation.js';
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
