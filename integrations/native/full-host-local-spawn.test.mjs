import test from 'node:test';
import assert from 'node:assert/strict';
import {admitLocalDockerSpawn,admitDockerControl,admitDockerShell} from './real-container-boundary.mjs';
const args=['run','-i','--rm','--name','miniclaw-synthetic-restoration-role-1234'];
const options={stdio:['pipe','pipe','pipe']},state={ready:true,alreadyStarted:false};
test('ready original spawn shape is admitted, forbidden process/shell and altered options are rejected',()=>{
 assert.doesNotThrow(()=>admitLocalDockerSpawn('docker',args,options,state));
 for(const [command,a,o,s] of [['sh',args,options,state],['/qiwe-control/docker',args,options,state],['docker',args,{...options,shell:true},state],['docker',args,{...options,env:{}},state],['docker',args,options,{...state,ready:false}],['docker',args,options,{...state,alreadyStarted:true}],['docker',[...args.slice(0,4),'miniclaw-synthetic-other-1'],options,state]])assert.throws(()=>admitLocalDockerSpawn(command,a,o,s),/LOCAL_DOCKER_SPAWN/);
});
test('control refuses raw daemon command, foreign stop, exec and shell metacharacters',()=>{
 const owned=new Set([args[4]]);
 for(const a of [['rm','-f',args[4]],['exec',args[4],'sh'],['stop','miniclaw-synthetic-other-1'],['run','anything']])assert.throws(()=>admitDockerControl('docker',a,owned),/REAL_CONTAINER/);
 for(const command of ['docker stop '+args[4]+'; echo x','docker exec '+args[4]+' sh','sh -c docker'])assert.throws(()=>admitDockerShell(command,owned),/REAL_CONTAINER/);
});
