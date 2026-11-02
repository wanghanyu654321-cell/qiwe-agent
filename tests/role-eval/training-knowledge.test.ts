import {it,expect} from 'vitest';import {createHash} from 'node:crypto';import fs from 'node:fs';import os from 'node:os';import path from 'node:path';
import {parseTrainingSummary,searchTrainingSummary,createTrainingSummaryService} from '../../src/role-eval/training-knowledge.js';
const scope={accountId:'owner',workspaceJid:'web:local-training'};
const body='# 测试知识库总结\n\n## 家访方法\n\n### 家访五步法\n企业现状摸底 → 老板沟通 → 团队诊断 → 一对一赋能 → 目标共识。\n\n## 报告研究\n总结称82%来自老客，此处未提供原始样本。\n\n说明：基于标题、摘要及采样。';
const sha=(s:string)=>createHash('sha256').update(s).digest('hex');
function summary(){return parseTrainingSummary(body,sha(body),scope,'summary.md')!;}
it('indexes exact summary excerpts with original line citations and pinned content hash',()=>{
 const s=summary();expect(s?.sha256).toBe(sha(body));const part=s.sections.find(x=>x.heading.includes('五步法'))!;expect(part.startLine).toBe(5);expect(part.endLine).toBe(7);expect(part.text).toContain('团队诊断');expect(body.split('\n').slice(part.startLine-1,part.endLine).join('\n')).toBe(part.text);
});
it('rejects altered text instead of accepting stale provenance',()=>{expect(()=>parseTrainingSummary(body+'changed',sha(body),scope,'summary.md')).toThrow('training_source_changed');});
it('requires a bounded real Markdown summary and trusted scope',()=>{
 expect(()=>parseTrainingSummary('',sha(''),scope,'summary.md')).toThrow();expect(()=>parseTrainingSummary('plain text',sha('plain text'),scope,'summary.md')).toThrow();expect(()=>parseTrainingSummary(body,sha(body),{...scope,accountId:''},'summary.md')).toThrow();
});
it('finds the method in the supplied summary without turning it into original case evidence',()=>{
 const r=searchTrainingSummary(summary(),'家访 五步法',scope);expect(r.status).toBe('summary_matches');expect(r.matches[0]?.heading).toContain('五步法');expect(r.primaryDocumentsAvailable).toBe(0);expect(r.frequencyCounts).toBeNull();
});
it('does not substitute an unrelated class or summary statistics for absent original records',()=>{
 const r=searchTrainingSummary(summary(),'115班 大单总结',scope);expect(r.matches).toEqual([]);expect(r.status).toBe('primary_source_missing');expect(searchTrainingSummary(summary(),'第1旬 vs 第7旬 信念频率',scope).frequencyCounts).toBeNull();
});
it('rejects cross-account and cross-workspace access before returning excerpts',()=>{
 expect(()=>searchTrainingSummary(summary(),'家访',{...scope,accountId:'other'})).toThrow('training_scope_denied');expect(()=>searchTrainingSummary(summary(),'家访',{...scope,workspaceJid:'web:other'})).toThrow('training_scope_denied');
});
it('rejects malformed queries instead of matching every document',()=>{expect(()=>searchTrainingSummary(summary(),'',scope)).toThrow('invalid_training_query');expect(()=>searchTrainingSummary(summary(),{query:'家访'},scope)).toThrow('invalid_training_query');});
function stored(){const dir=fs.mkdtempSync(path.join(os.tmpdir(),'training-summary-')),hash=sha(body);fs.writeFileSync(path.join(dir,'approval.json'),JSON.stringify({kind:'user_provided_summary',scope,sha256:hash,fileName:'summary.md'}));fs.writeFileSync(path.join(dir,'summary-'+hash+'.json'),JSON.stringify({scope,sha256:hash,sourceText:body}));return {dir,hash};}
it('a new reader resumes the approved persistent summary without duplicate documents',()=>{const {dir,hash}=stored();expect(createTrainingSummaryService(dir,scope).overview().documentsAvailable).toBe(1);const fresh=createTrainingSummaryService(dir,scope);expect(fresh.overview().sourceId).toBe(hash);expect(fresh.search('家访').matches.length).toBeGreaterThan(0);});
it('tampering and revoked scope become unavailable rather than a successful empty search',()=>{
 const {dir,hash}=stored();fs.writeFileSync(path.join(dir,'summary-'+hash+'.json'),JSON.stringify({scope,sha256:hash,sourceText:body+'tampered'}));const reader=createTrainingSummaryService(dir,scope);expect(reader.overview().status).toBe('unavailable');expect(()=>reader.search('家访')).toThrow('training_source_changed');
 const other=stored();expect(createTrainingSummaryService(other.dir,{...scope,accountId:'other'}).overview().available).toBe(false);expect(()=>createTrainingSummaryService(other.dir,{...scope,accountId:'other'}).search('家访')).toThrow('training_scope_denied');
});
function collection(){
 const {dir,hash}=stored(),second='# 合成家访教材\n\n## 多人家访\n采用U字形座位进行培训练习。',id=sha(second);
 const documents=[{sha256:hash,fileName:'summary.md',category:'资料总览',evidenceLevel:'secondary_summary'},{sha256:id,fileName:'visit.md',category:'家访实操',evidenceLevel:'provided_training_text'}];
 fs.writeFileSync(path.join(dir,'summary-'+id+'.json'),JSON.stringify({scope,sha256:id,sourceText:second}));
 const approval={kind:'user_provided_training_library',scope,usage:'teaching_training_only',documents};
 fs.writeFileSync(path.join(dir,'approval.json'),JSON.stringify(approval));return {dir,hash,id,second,approval};
}
it('keeps the previous overview while retrieving additional teaching materials with per-file citations',()=>{
 const {dir,id,second}=collection(),reader=createTrainingSummaryService(dir,scope);
 expect(reader.overview().documentsAvailable).toBe(2);
 const r=reader.search('U字形');expect(r.matches).toHaveLength(1);
 expect(r.matches[0]).toMatchObject({documentId:id,fileName:'visit.md',category:'家访实操',evidenceLevel:'provided_training_text'});
 expect(r.matches[0]!.text).toBe(second.split('\n').slice(2).join('\n'));
 expect(createTrainingSummaryService(dir,scope).search('U字形')).toEqual(r);
 expect(reader.search('家访 五步法').matches.some(m=>m.text.includes('团队诊断'))).toBe(true);
});
it('rejects duplicate versions, revoked materials and a non-training purpose rather than silently using a subset',()=>{
 for(const mutation of ['duplicate','purpose','tamper']){const {dir,id,approval}=collection();
  if(mutation==='duplicate')approval.documents.push(approval.documents[0]!);
  if(mutation==='purpose')approval.usage='marketing';
  if(mutation==='tamper')fs.writeFileSync(path.join(dir,'summary-'+id+'.json'),JSON.stringify({scope,sha256:id,sourceText:'changed'}));
  fs.writeFileSync(path.join(dir,'approval.json'),JSON.stringify(approval));
  expect(createTrainingSummaryService(dir,scope).overview().available).toBe(false);
  expect(()=>createTrainingSummaryService(dir,scope).search('家访')).toThrow();
 }
});
it('collection access is denied outside its owner and training workspace',()=>{
 const {dir}=collection();for(const s of [{...scope,accountId:'other'},{...scope,workspaceJid:'web:marketing'}])expect(()=>createTrainingSummaryService(dir,s).search('U字形')).toThrow('training_scope_denied');
});
it('keeps the summary text digest separate from the collection version in native profile context',()=>{
 const {dir,hash}=collection(),reader=createTrainingSummaryService(dir,scope),context=reader.context();
 expect(context.sha256).toBe(hash);expect(sha(context.sourceText)).toBe(context.sha256);
 expect(context.libraryId).toBe(reader.overview().sourceId);expect(context.libraryId).not.toBe(hash);
});
it('natural full-sentence questions retain concept relevance across files instead of sorting only by filename',()=>{
 const {dir,approval,hash}=collection();approval.documents[1]!.fileName='a-case.md';fs.writeFileSync(path.join(dir,'approval.json'),JSON.stringify(approval));
 const result=createTrainingSummaryService(dir,scope).search('请根据家访五步法帮助一名新任指导员准备首次家访。');
 expect(result.matches[0]?.documentId).toBe(hash);expect(result.matches[0]?.heading).toContain('五步法');
});
