import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import {spawnSync} from 'node:child_process';
import ts from 'typescript';

// Execute the actual offline provider function without booting Docker or
// importing the original main. Only the surrounding bootstrap is excluded.
const source=fs.readFileSync(new URL('./real-container-provider.mjs',import.meta.url),'utf8');
const parsed=ts.createSourceFile('provider.mjs',source,ts.ScriptTarget.Latest,true,ts.ScriptKind.JS);
const assignment=parsed.statements.find(node=>ts.isExpressionStatement(node)&&ts.isBinaryExpression(node.expression)&&node.expression.left.getText(parsed)==='ModelRuntime.prototype.streamSimple');
assert.ok(assignment,'one provider stream assignment must remain observable');
const beauty='仅使用批准资料；资料不足返回 partial，不能编造金额或人数。';
const provider=()=>vm.runInNewContext('('+assignment.expression.right.getText(parsed)+')',{
 fs:{readFileSync:()=>beauty},path,record:()=>{},Date,JSON,AbortSignal,setInterval,clearInterval,
});
const model={api:'synthetic',provider:'offline',id:'c4'};
const request={role:'user',content:'[c4-synthetic] 根据批准资料和三个内容技能，写美容门店体验活动的未发布草稿，保留人数和行动建议。'};
const skills=['beauty-local-content','vendor-content-strategy','vendor-copywriting'];
const observation=(id,text,isError=false)=>({role:'toolResult',toolCallId:id,toolName:'read',content:[{type:'text',text}],isError});
const observed=()=>[
 observation('approved','synthetic-approved-v1: 每场限额 12 人'),
 observation('skill',beauty),
 observation('strategy','把主题对应到可展示的服务步骤，并列拍摄资源需求。'),
 observation('copywriting','一句话一个意思。行动号召为咨询核对项目。使用单一行动号召。'),
 observation('forbidden-project','ENOENT',true),observation('forbidden-user','ENOENT',true),
];
async function answer(results){const message=await provider()(model,{messages:[request,...results]},{}).result();return JSON.parse(message.content[0].text);}

test('ordinary provider mode retains its four reads and original frozen answer contract',async()=>{
 const user={role:'user',content:'original ordinary synthetic request'},stream=provider();
 const initial=await stream(model,{messages:[user]},{}).result();assert.equal(initial.content.length,4);
 const results=observed().filter(result=>!['strategy','copywriting'].includes(result.toolCallId));
 const final=await stream(model,{messages:[user,...results]},{}).result();
 assert.deepEqual(JSON.parse(final.content[0].text),{tag:'synthetic-real-container-answer',approved:'synthetic-approved-v1: 每场限额 12 人',skillRead:true,denied:true,priorAnswer:false});
});
test('C4 provider requests approved material and all three installed skills through read',async()=>{
 const message=await provider()(model,{messages:[request]},{}).result();
 const calls=message.content.filter(part=>part.type==='toolCall');
 assert.deepEqual(Array.from(calls,call=>call.arguments.path),['approved.txt',...skills.map(id=>'/home/node/.claude/skills/'+id+'/SKILL.md'),'/workspace/project/private.txt','/workspace/other-user/private.txt']);
 assert.ok(calls.every(call=>call.name==='read'));assert.equal(message.stopReason,'toolUse');
});
test('C4 draft uses the observed fact and methods with explicit sources and no execution',async()=>{
 const result=await answer(observed());
 assert.equal(result.status,'draft');assert.equal(result.executed,false);assert.equal(result.published,false);
 assert.equal(result.draft.evidence,'synthetic-approved-v1');assert.equal(result.draft.source,'approved.txt');
 assert.match(result.draft.copy,/每场限额 12 人/);assert.match(result.draft.copy,/咨询核对项目/);
 assert.deepEqual(result.draft.methods.map(method=>method.source),['vendor-content-strategy/SKILL.md','vendor-copywriting/SKILL.md']);
 assert.equal(result.skillRead,true);assert.equal(result.denied,true);
 const changed=observed();changed[0]=observation('approved','synthetic-approved-v1: 每场限额 7 人');
 assert.match((await answer(changed)).draft.copy,/每场限额 7 人/);
});
test('failed approved read yields partial without inventing a successful draft or numeric facts',async()=>{
 const results=observed();results[0]=observation('approved','ENOENT: approved.txt is missing',true);
 const result=await answer(results);
 assert.equal(result.status,'partial');assert.equal(result.draft,null);assert.deepEqual(result.missingMaterial,['approved.txt']);
 assert.equal(result.executed,false);assert.equal(result.published,false);assert.equal(result.denied,true);
 assert.doesNotMatch(JSON.stringify(result),/12|限额|元|项目体验介绍/);
});
test('missing, duplicate or errored method observations cannot produce a successful C4 draft',async()=>{
 const missing=observed().filter(result=>result.toolCallId!=='strategy');
 const duplicate=[...observed(),observation('copywriting','行动号召为虚构优惠。')];
 const failed=observed();failed[3]=observation('copywriting','行动号召为虚构优惠。',true);
 for(const results of [missing,duplicate,failed]){const result=await answer(results);assert.equal(result.status,'partial');assert.equal(result.draft,null);assert.ok(result.missingMaterial.length>0);}
});

const root=path.resolve(import.meta.dirname,'../..');
const base=[path.join(root,'integrations/native/verify-full-host.mjs'),path.join(root,'.local/nonexistent-c4-source'),'--host-overlay',path.join(root,'.local/nonexistent-c4-overlay'),'--full-host-conversations','--restoration-scenario','--restoration-real-container','--skill-root',path.join(root,'.local/nonexistent-c4-skills')];
const run=args=>spawnSync(process.execPath,args,{cwd:root,encoding:'utf8',timeout:10000});
test('full-host C4 choices are explicit and accepted by argument parsing only with real container',()=>{
 for(const choice of ['grounded','missing-evidence']){const result=run([...base,'--c4-synthetic-case',choice]);assert.notEqual(result.status,0);assert.doesNotMatch(result.stderr,/Invalid Native verification arguments|Invalid C4 synthetic case option/);}
});
test('full-host rejects unknown, missing, duplicate and non-real C4 options before any fixture starts',()=>{
 for(const args of [
  [...base,'--c4-synthetic-case','invented'],[...base,'--c4-synthetic-case'],
  [...base,'--c4-synthetic-case','grounded','--c4-synthetic-case','missing-evidence'],
  [...base.filter(value=>value!=='--restoration-real-container'),'--c4-synthetic-case','grounded'],
 ]){const result=run(args);assert.notEqual(result.status,0);assert.match(result.stderr,/Invalid C4 synthetic case option/);}
});
