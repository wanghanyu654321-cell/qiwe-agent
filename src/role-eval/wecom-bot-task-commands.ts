import type {WorkbenchRole} from './workbench-access.js';
import type {BotTaskInput} from './wecom-bot-task-store.js';
export type BotTaskCommand={kind:'start';role:WorkbenchRole;input:BotTaskInput}|{kind:'query';role:WorkbenchRole;taskId:string;page:number}|{kind:'cancel';role:WorkbenchRole;taskId:string}|{kind:'invalid';role:WorkbenchRole;message:string};
const roles:Record<string,WorkbenchRole>={客服接待:'reception',前台办理:'frontdesk',内容营销:'marketing',投放辅助:'ads',店长经营:'manager',评测质检:'qa',培训:'training',reception:'reception',frontdesk:'frontdesk',marketing:'marketing',ads:'ads',manager:'manager',qa:'qa',training:'training'};
export function parseBotTaskCommand(text:string):BotTaskCommand|undefined{
 const value=text.trim(),start=/^执行任务\s+(\S+)\s+([A-Za-z0-9_-]{1,64})$/.exec(value);
 if(start&&Object.hasOwn(roles,start[1]!))return {kind:'start',role:roles[start[1]!]!,input:{kind:'native',alias:start[2]!}};
 const personas:Record<string,'instructor'|'executive'|'chief'>={指导员:'instructor',执总:'executive',总指导:'chief'},training=/^培训(问答|教案)\s+(指导员|执总|总指导)\s+([\s\S]+)$/.exec(value);
 if(training&&training[3]!.trim().length<=2000)return {kind:'start',role:'training',input:{kind:'training',mode:training[1]==='问答'?'question':'lesson',persona:personas[training[2]!]!,query:training[3]!.trim()}};
 const lookup=/^(查询任务|取消任务)\s+(\S+)\s+([a-f0-9]{64})(?:\s+([1-9]\d{0,2}))?$/.exec(value);
 if(lookup&&Object.hasOwn(roles,lookup[2]!)&&(lookup[1]==='查询任务'||lookup[4]===undefined))return lookup[1]==='查询任务'?{kind:'query',role:roles[lookup[2]!]!,taskId:lookup[3]!,page:Number(lookup[4]??1)}:{kind:'cancel',role:roles[lookup[2]!]!,taskId:lookup[3]!};
 if(/^(执行任务|培训问答|培训教案|查询任务|取消任务)/.test(value)){const label=value.split(/\s+/)[1]??'';return {kind:'invalid',role:value.startsWith('培训')?'training':Object.hasOwn(roles,label)?roles[label]!:'manager',message:'请发送：执行任务 岗位 已有任务别名；培训问答/培训教案 指导员/执总/总指导 问题；查询任务 岗位 编号 [页码]；取消任务 岗位 编号。'};}
 return undefined;
}
