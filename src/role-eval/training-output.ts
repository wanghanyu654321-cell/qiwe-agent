export interface TrainingOutput {answer:string;lesson:null|{title:string;goals:string[];steps:{minutes:number;activity:string;practice:string;evidence:string}[];assessment:string[];followUp:string[]};citations:string[];limitations:string[];}
const obj=(v:unknown):v is Record<string,unknown>=>!!v&&typeof v==='object'&&!Array.isArray(v);
const text=(v:unknown):v is string=>typeof v==='string'&&v.trim().length>0&&v.length<=4000;
const strings=(v:unknown):v is string[]=>Array.isArray(v)&&v.length>0&&v.length<=12&&v.every(text);
const keys=(v:Record<string,unknown>,expected:string[])=>Object.keys(v).length===expected.length&&expected.every(k=>Object.hasOwn(v,k));
export function isTrainingOutput(v:unknown,mode:'question'|'lesson',sourceIds:string[]):v is TrainingOutput{
 if(!obj(v)||!keys(v,['answer','lesson','citations','limitations'])||!text(v.answer)||!strings(v.citations)||new Set(v.citations).size!==v.citations.length||!v.citations.every(id=>sourceIds.includes(id))||!strings(v.limitations))return false;
 if(mode==='question')return v.lesson===null;
 const l=v.lesson;if(!obj(l)||!keys(l,['title','goals','steps','assessment','followUp'])||!text(l.title)||!strings(l.goals)||!strings(l.assessment)||!strings(l.followUp)||!Array.isArray(l.steps)||l.steps.length<3||l.steps.length>10)return false;
 return l.steps.every(s=>obj(s)&&keys(s,['minutes','activity','practice','evidence'])&&Number.isSafeInteger(s.minutes)&&Number(s.minutes)>0&&text(s.activity)&&text(s.practice)&&text(s.evidence))&&l.steps.reduce((n,s)=>n+Number(s.minutes),0)===45;
}
export const TRAINING_OUTPUT_CONTRACT='只输出JSON，最外层恰好四个字段：answer:string（简明回答/教案摘要），lesson（问答时必须null；教案时为对象，恰好title:string、goals:string[]、steps:{minutes:正整数,activity:string,practice:string,evidence:string}[]至少3步且分钟之和45、assessment:string[]、followUp:string[]），citations:string[]（只能用本次工具返回的完整段落id，不可改写，至少1条），limitations:string[]（至少说明合成练习/来源局限/人工审核）。不使用Markdown围栏，不加其他字段。不虚构原始案例/统计、医学效果或培训完成。';
