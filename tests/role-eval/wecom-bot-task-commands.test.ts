import {it,expect} from 'vitest';
import {parseBotTaskCommand} from '../../src/role-eval/wecom-bot-task-commands.js';
it('selects only explicit granted role names and server aliases without accepting backend IDs',()=>{
 expect(parseBotTaskCommand('执行任务 内容营销 weekly-post')).toEqual({kind:'start',role:'marketing',input:{kind:'native',alias:'weekly-post'}});
 expect(parseBotTaskCommand('培训问答 指导员 家访前先核对什么')).toEqual({kind:'start',role:'training',input:{kind:'training',mode:'question',persona:'instructor',query:'家访前先核对什么'}});
 expect(parseBotTaskCommand('培训教案 总指导 家访练习')).toEqual({kind:'start',role:'training',input:{kind:'training',mode:'lesson',persona:'chief',query:'家访练习'}});
});
it('requires the explicit role and exact task reference for lookup and cancellation',()=>{
 const id='a'.repeat(64);expect(parseBotTaskCommand(`查询任务 培训 ${id} 2`)).toEqual({kind:'query',role:'training',taskId:id,page:2});
 expect(parseBotTaskCommand(`取消任务 marketing ${id}`)).toEqual({kind:'cancel',role:'marketing',taskId:id});
 for(const text of ['执行任务 内容营销 ../script','执行任务 admin tool','培训问答 owner hi',`取消任务 培训 ${id} all`,`查询任务 培训 ${id} 0`])expect(parseBotTaskCommand(text)?.kind).toBe('invalid');
 expect(parseBotTaskCommand('今天销售成交200元')).toBeUndefined();expect(parseBotTaskCommand('查询 '+'a'.repeat(64))).toBeUndefined();
});
