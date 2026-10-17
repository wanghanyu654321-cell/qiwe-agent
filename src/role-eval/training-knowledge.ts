import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
export interface TrainingScope {accountId:string;workspaceJid:string;}
export interface TrainingSummary {title:string;sha256:string;fileName:string;scope:TrainingScope;sourceText:string;sections:{id:string;heading:string;startLine:number;endLine:number;text:string}[];}
export interface TrainingDocument {sha256:string;fileName:string;category:string;evidenceLevel:'secondary_summary'|'provided_training_text';}
export const TRAINING_USAGE='teaching_training_only';
const categories=['资料总览','家访实操','认知成长','组织诊断','案例研讨'];
function validScope(scope:TrainingScope){return scope&&typeof scope.accountId==='string'&&!!scope.accountId&&typeof scope.workspaceJid==='string'&&scope.workspaceJid==='web:local-training';}
function sameScope(a:TrainingScope,b:TrainingScope){return validScope(a)&&validScope(b)&&a.accountId===b.accountId&&a.workspaceJid===b.workspaceJid;}
export function parseTrainingSummary(text:string,hash:string,scope:TrainingScope,fileName:string):TrainingSummary {
 if(typeof text!=='string'||!text.trim()||Buffer.byteLength(text)>256000||!validScope(scope)||!fileName.endsWith('.md')||/[\\/:]/.test(fileName))throw Error('invalid_training_source');
 if(!/^[a-f0-9]{64}$/.test(hash)||createHash('sha256').update(text).digest('hex')!==hash)throw Error('training_source_changed');
 const lines=text.split(/\r?\n/),title=lines.find(x=>/^#\s+/.test(x))?.replace(/^#\s+/,'').trim();
 const starts=lines.flatMap((line,i)=>/^#{2,3}\s+/.test(line)?[i]:[]);if(!title||!starts.length)throw Error('invalid_training_source');
 let chapter='';const sections=starts.map((start,i)=>{const end=starts[i+1]??lines.length,line=lines[start]!;if(/^##\s/.test(line))chapter=line.replace(/^##\s+/,'');const heading=/^###\s/.test(line)?chapter+' / '+line.replace(/^###\s+/,''):chapter;return {id:hash+':L'+(start+1)+'-'+end,heading,startLine:start+1,endLine:end,text:lines.slice(start,end).join('\n')};});
 return {title,sha256:hash,scope:{...scope},fileName,sourceText:text,sections};
}
function trainingQueryTokens(q:string){
 const keywords=['家访','五步法','企业诊断','指导员','带教','董事长','店长','培养','考核','试卷','旬总结','数据','复盘','规则','制度','积分','作战地图','风险','热力图','鱼骨图','客户盘点','信念','挂零','大单','客户','培训','课程','目标','班级','成长','团队','金字塔','翻译官','运动','大脑','根源'].filter(x=>q.includes(x));
 const tokens=[...new Set([...q.split(/[\s，,、]+/).filter(x=>x.length>1),...keywords])];
 return tokens;
}
export function searchTrainingSummary(summary:TrainingSummary,query:unknown,scope:TrainingScope){
 if(!sameScope(summary.scope,scope))throw Error('training_scope_denied');
 if(typeof query!=='string'||!query.trim()||query.length>2000)throw Error('invalid_training_query');
 const q=query.trim(),classes=[...q.matchAll(/(\d{1,4})班/g)].map(m=>m[1]+'班');
 const tokens=trainingQueryTokens(q);
 const score=(s:TrainingSummary['sections'][number])=>tokens.reduce((n,t)=>n+(s.heading.includes(t)?5:0)+(s.text.includes(t)?1:0),0);
 const matches=summary.sections.filter(s=>classes.every(c=>new RegExp('(?:^|[^0-9])'+c).test(s.text))&&score(s)>0).sort((a,b)=>score(b)-score(a)||a.startLine-b.startLine).slice(0,6);
 const needsPrimary=classes.length>0||/词频|出现.*次|频率|真实案例|157|第\s*\d+\s*旬|PK|对比|vs/i.test(q);
 return {status:needsPrimary?'primary_source_missing':matches.length?'summary_matches':'no_summary_match',matches,primaryDocumentsAvailable:0,frequencyCounts:null};
}
/** Only this training workspace consumes these approved local files. Not a Native Memory importer. */
export function createTrainingSummaryService(dir:string,scope:TrainingScope){
 const load=()=>{
  const approval=JSON.parse(fs.readFileSync(path.join(dir,'approval.json'),'utf8'));
  if(!sameScope(approval.scope,scope))throw Error('training_scope_denied');
  const legacy=approval.kind==='user_provided_summary';
  if(!legacy&&(approval.kind!=='user_provided_training_library'||approval.usage!==TRAINING_USAGE))throw Error('training_scope_denied');
  const refs:TrainingDocument[]=legacy?[{sha256:approval.sha256,fileName:approval.fileName,category:'资料总览',evidenceLevel:'secondary_summary'}]:approval.documents;
  if(!Array.isArray(refs)||!refs.length||refs.length>50)throw Error('invalid_training_library');
  const ids=new Set<string>(),names=new Set<string>();let bytes=0;
  const documents=refs.map(ref=>{
   if(!ref||!/^[a-f0-9]{64}$/.test(ref.sha256)||typeof ref.fileName!=='string'||!categories.includes(ref.category)||!['secondary_summary','provided_training_text'].includes(ref.evidenceLevel)||ids.has(ref.sha256)||names.has(ref.fileName))throw Error('invalid_training_library');
   ids.add(ref.sha256);names.add(ref.fileName);
   const data=JSON.parse(fs.readFileSync(path.join(dir,'summary-'+ref.sha256+'.json'),'utf8'));
   if(!sameScope(data.scope,scope)||data.sha256!==ref.sha256)throw Error('training_scope_denied');
   const parsed=parseTrainingSummary(data.sourceText,ref.sha256,scope,ref.fileName);bytes+=Buffer.byteLength(parsed.sourceText);
   if(bytes>1000000)throw Error('training_library_too_large');
   return {...parsed,category:ref.category,evidenceLevel:ref.evidenceLevel};
  });
  const catalog=documents.map(s=>({sha256:s.sha256,fileName:s.fileName,title:s.title,category:s.category,evidenceLevel:s.evidenceLevel,sections:s.sections.length}));
  const id=legacy?documents[0]!.sha256:createHash('sha256').update(JSON.stringify({usage:TRAINING_USAGE,documents:catalog})).digest('hex');
  return {id,documents,catalog};
 };
 const overview=()=>{try{const s=load();return {status:'summary_available',available:true,documentsAvailable:s.documents.length,caseDocumentsAvailable:0,sourceId:s.id,fileName:s.documents.length===1?s.documents[0]!.fileName:'培训专用资料库',title:s.documents.length===1?s.documents[0]!.title:'教学培训资料',sections:s.documents.reduce((n,d)=>n+d.sections.length,0),evidenceLevel:'secondary_summary',fullCorpus:false,modelEnabled:false,usage:TRAINING_USAGE,documents:s.catalog};}catch{const missing=!fs.existsSync(path.join(dir,'approval.json'));return {status:missing?'not_imported':'unavailable',available:false,documentsAvailable:0,caseDocumentsAvailable:0,sourceId:null,fileName:null,title:null,sections:0,evidenceLevel:'secondary_summary',fullCorpus:false,modelEnabled:false,usage:TRAINING_USAGE,documents:[]};}};
 return {overview,context(){const s=load(),summary=s.documents.find(d=>d.category==='资料总览')??s.documents[0]!;return {...summary,libraryId:s.id,catalog:s.catalog,usage:TRAINING_USAGE};},search(query:unknown){
  const s=load();const results=s.documents.map(d=>({d,result:searchTrainingSummary(d,query,scope)}));
  const tokens=trainingQueryTokens(String(query).trim());
  const matches=results.flatMap(({d,result})=>result.matches.map(m=>({...m,documentId:d.sha256,fileName:d.fileName,category:d.category,evidenceLevel:d.evidenceLevel,rank:tokens.reduce((n,t)=>n+(m.heading.includes(t)?5:0)+(m.text.includes(t)?1:0)+(d.title.includes(t)?2:0),0)}))).sort((a,b)=>b.rank-a.rank||a.fileName.localeCompare(b.fileName)||a.startLine-b.startLine).slice(0,6).map(({rank:_,...m})=>m);
  return {status:results.some(r=>r.result.status==='primary_source_missing')?'primary_source_missing':matches.length?'summary_matches':'no_summary_match',matches,primaryDocumentsAvailable:0,frequencyCounts:null,source:{id:s.id,fileName:s.documents.length===1?s.documents[0]!.fileName:'培训专用资料库',title:'教学培训资料',evidenceLevel:'secondary_summary',fullCorpus:false,usage:TRAINING_USAGE},modelCalls:0};
 }};
}
