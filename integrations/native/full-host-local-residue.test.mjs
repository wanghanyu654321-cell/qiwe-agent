import test from 'node:test';
import assert from 'node:assert/strict';
import {classifyLocalRunnerFile,classifyLocalRunnerLink,settledLocalSessions} from './full-host-local-residue.mjs';
const folder='synthetic-restoration-role',id='12345678-1234-1234-1234-123456789abc';
const context=[{folder,sessionId:id,content:'frozen synthetic answer',input:{id:'input-one',content:'request'}}];
const name=`sessions/${folder}/.claude/sessions/2026-10-24T00-00-00-000Z_${id}.jsonl`;
const entries=()=>[{type:'session',version:3,id,timestamp:'2026-10-24T00:00:00.000Z',cwd:'/workspace/group'},
 {type:'message',id:'11111111',parentId:null,timestamp:'2026-10-24T00:00:00.000Z',message:{role:'user',content:[{type:'text',text:'<messages><message id="input-one" sender="synthetic">request</message></messages>'}],timestamp:1}},
 {type:'message',id:'22222222',parentId:'11111111',timestamp:'2026-10-24T00:00:00.000Z',message:{role:'assistant',content:[{type:'toolCall',id:'read-one',name:'read',arguments:{path:'approved.txt'}}],stopReason:'toolUse',timestamp:1}},
 {type:'message',id:'33333333',parentId:'22222222',timestamp:'2026-10-24T00:00:00.000Z',message:{role:'toolResult',toolCallId:'read-one',toolName:'read',content:[{type:'text',text:'material'}],isError:false,timestamp:1}},
 {type:'message',id:'44444444',parentId:'33333333',timestamp:'2026-10-24T00:00:00.000Z',message:{role:'assistant',content:[{type:'text',text:'frozen synthetic answer'}],stopReason:'stop',timestamp:1}}];
const encode=rows=>rows.map(v=>JSON.stringify(v)).join('\n')+'\n';
test('accepts only completed same-session linear SDK history ending in exact D5 text',()=>assert.equal(classifyLocalRunnerFile(name,encode(entries()),context),'settled_pi_session_exact_d5'));
test('requires canonical SDK filename',()=>{
 assert.equal(classifyLocalRunnerFile(name.replace('00-00-00-000Z','00-00-01-000Z'),encode(entries()),context),undefined);
});
test('rejects a second same-session file in the bounded walk',()=>{
 const seen=new Set();
 assert.equal(classifyLocalRunnerFile(name,encode(entries()),context,seen),'settled_pi_session_exact_d5');
 const later=entries();later[0].timestamp='2026-10-24T00:00:01.000Z';
 assert.equal(classifyLocalRunnerFile(name.replace('00-00-00-000Z','00-00-01-000Z'),encode(later),context,seen),undefined);
});
test('rejects unrelated session, changed final, missing tool result, unsafe tool and malformed chain',()=>{
 for(const mutate of [r=>r[0].id='other',r=>r.at(-1).message.content[0].text='forged',r=>r.splice(3,1),r=>r[2].message.content[0].name='bash',r=>r[3].parentId=null,r=>r.pop()]){const rows=entries();mutate(rows);assert.equal(classifyLocalRunnerFile(name,encode(rows),context),undefined);}
 assert.equal(classifyLocalRunnerFile(name,encode(entries()),[]),undefined);
});
test('strict passive config does not grant hooks, MCP, model/auth credentials or shell environment',()=>{
 const root=`sessions/${folder}/.claude/`;
 for(const file of ['.miniclaw-native-settings.json','agent/auth.json','agent/models-store.json']){assert.ok(classifyLocalRunnerFile(root+file,'{}',context));assert.equal(classifyLocalRunnerFile(root+file,'{"token":"unexpected"}',context),undefined);}
 assert.ok(classifyLocalRunnerFile(root+'agent/settings.json','{"compaction":{"enabled":true}}',context));
 assert.equal(classifyLocalRunnerFile(root+'agent/settings.json','{"compaction":{"enabled":true},"extensions":["bad.js"]}',context),undefined);
 assert.ok(classifyLocalRunnerFile(`env/${folder}/default/main/env`,"MINICLAW_CLAUDE_ENDPOINT_KIND='official'\n",context));
 assert.equal(classifyLocalRunnerFile(`env/${folder}/default/main/env`,"MINICLAW_CLAUDE_ENDPOINT_KIND='official';bad\n",context),undefined);
 assert.ok(classifyLocalRunnerFile('config/container-claude-json.json','{"hasCompletedOnboarding":true,"autoUpdates":false}',context));
 const settings={env:{CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS:'0',CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD:'0',CLAUDE_CODE_DISABLE_AUTO_MEMORY:'1',CLAUDE_CODE_DISABLE_ATTACHMENTS:'1'},mcpServers:{}};
 assert.ok(classifyLocalRunnerFile(root+'settings.json',JSON.stringify(settings),context));
 for(const changed of [{...settings,hooks:{}},{...settings,mcpServers:{unapproved:{command:'sh'}}},{...settings,env:{...settings.env,PATH:'/unapproved'}}])assert.equal(classifyLocalRunnerFile(root+'settings.json',JSON.stringify(changed),context),undefined);
});
test('session context requires verified D5, completed same workspace execution, native session registration and original input',()=>{
 const row={session_id:id,content:'frozen synthetic answer',receipt_id:'receipt',query_id:'query',turn_id:'input-one'};
 const rows=new Map([['wecom_conversation_execution',[{receipt_id:'receipt',state:'completed',session_id:id,query_id:'query',turn_id:'input-one',workspace_jid:'workspace',input_json:'["input-one"]',message_id:'input-one'}]],['registered_groups',[{jid:'workspace',folder,execution_mode:'container'}]],['sessions',[{group_folder:folder,session_id:id}]],['messages',[{chat_jid:'workspace',id:'input-one',is_from_me:0,content:'request'}]]]);
 const records=[{table:'wecom_conversation_results',row,record:{evidence:['d5_frozen_result_verified']}}];
 assert.deepEqual(settledLocalSessions(rows,records),context);
 assert.deepEqual(settledLocalSessions(rows,[{...records[0],record:{evidence:[]}}]),[]);
 for(const key of ['sessions','messages','registered_groups']){const changed=new Map(rows);changed.set(key,[]);assert.deepEqual(settledLocalSessions(changed,records),[]);}
 const changedContext=[{...context[0],input:{id:'input-one',content:'changed'}}];assert.equal(classifyLocalRunnerFile(name,encode(entries()),changedContext),undefined);
});
test('only original rebuilt skill links are passive; unknown or changed targets stay unsafe',()=>{
 const key=`sessions/${folder}/.claude/skills/beauty-local-content`;
 assert.equal(classifyLocalRunnerLink(key,'/workspace/effective-skills/beauty-local-content',context),'original_rebuilt_skill_link');
 for(const target of ['/etc','/workspace/effective-skills/../private','/workspace/effective-skills/vendor-copywriting'])assert.equal(classifyLocalRunnerLink(key,target,context),undefined);
 assert.equal(classifyLocalRunnerLink(key,'/workspace/effective-skills/beauty-local-content',[]),undefined);
});
