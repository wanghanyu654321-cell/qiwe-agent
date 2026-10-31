import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {admitPiSessionBeyondSyntheticProtocol,requiredPiOfflineSamples} from './pi-session-recovery.mjs';
import {classifyLocalRunnerFile} from './full-host-local-residue.mjs';

const folder='synthetic-restoration-role',id='12345678-1234-1234-1234-123456789abc';
const context=[{folder,sessionId:id,content:'frozen synthetic answer',input:{id:'input-one',content:'request'}}];
const name=`sessions/${folder}/.claude/sessions/2026-10-24T00-00-00-000Z_${id}.jsonl`;
const header={type:'session',version:3,id,timestamp:'2026-10-24T00:00:00.000Z',cwd:'/workspace/group'};
const user={type:'message',id:'11111111',parentId:null,timestamp:'2026-10-24T00:00:00.000Z',message:{role:'user',content:[{type:'text',text:'<messages><message id="input-one" sender="synthetic">request</message></messages>'}],timestamp:1}};
const encode=rows=>rows.map(value=>JSON.stringify(value)).join('\n')+'\n';
test('direct answer, follow-up and non-read tool stay unaccepted without an offline sample',()=>{
 const answer={type:'message',id:'22222222',parentId:'11111111',timestamp:'2026-10-24T00:00:00.000Z',message:{role:'assistant',content:[{type:'text',text:'frozen synthetic answer'}],stopReason:'stop',timestamp:1}};
 assert.equal(classifyLocalRunnerFile(name,encode([header,user,answer]),context),undefined);
 const follow={...user,id:'33333333',parentId:'22222222'};
 assert.equal(classifyLocalRunnerFile(name,encode([header,user,answer,follow]),context),undefined);
 const tool={type:'message',id:'22222222',parentId:'11111111',timestamp:'2026-10-24T00:00:00.000Z',message:{role:'assistant',content:[{type:'toolCall',id:'call',name:'bash',arguments:{command:'true'}}],stopReason:'toolUse',timestamp:1}};
 assert.equal(classifyLocalRunnerFile(name,encode([header,user,tool]),context),undefined);
});
test('guessed facts and a rerun callback cannot admit or execute a session',()=>{
 let rerun=0;assert.throws(()=>admitPiSessionBeyondSyntheticProtocol({schema:'guessed',rerun:()=>{rerun++;}}),/PI_SESSION_SCHEMA_UNCONFIRMED/);
 assert.equal(rerun,0);assert.deepEqual(admitPiSessionBeyondSyntheticProtocol(),{admitted:false,reason:'pi_offline_schema_unconfirmed',samples:requiredPiOfflineSamples()});
 assert.equal(fs.readFileSync(new URL('./pi-session-recovery.mjs',import.meta.url),'utf8').includes('child_process'),false);
});
