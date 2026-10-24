import test from 'node:test';
import assert from 'node:assert/strict';
import {validateLocalDockerFacts,translateLocalMounts} from './full-host-local-docker.mjs';
const runId='12345678-1234-1234-1234-123456789abc',hostId='a'.repeat(64),oldId='b'.repeat(64);
const expected={runId,hostId,volume:'qiwe-test',mountpoint:'/var/lib/docker/volumes/qiwe-test/_data',daemonId:'daemon',hostMounts:[{Type:'volume',Name:'qiwe-test',Source:'/var/lib/docker/volumes/qiwe-test/_data',Destination:'/tmp',RW:true}],oldContainerId:oldId};
expected.hostMounts.push(...['/input','/qiwe-control/build-input.json','/qiwe-control/docker','/qiwe-control/docker.sock'].map(Destination=>({Type:'bind',Source:'/source'+Destination,Destination,RW:false})));
const facts=()=>({daemonId:'daemon',volume:{Name:expected.volume,Mountpoint:expected.mountpoint,Driver:'local',Labels:{'qiwe.verification-run':runId}},host:{Id:hostId,Config:{User:'1000:1000',Labels:{'qiwe.verification-run':runId}},HostConfig:{NetworkMode:'none',ReadonlyRootfs:true,Privileged:false,CapDrop:['ALL'],SecurityOpt:['no-new-privileges']},Mounts:structuredClone(expected.hostMounts),State:{Running:true}},containers:[{Id:hostId,Mounts:structuredClone(expected.hostMounts)}]});
test('admits only pinned local daemon host and exclusive volume after old writer removal',()=>assert.doesNotThrow(()=>validateLocalDockerFacts(facts(),expected)));
test('rejects changed daemon/volume/host/mount and untracked old writers or parent exposure',()=>{
 for(const change of [f=>f.daemonId='other',f=>f.volume.Mountpoint='/other',f=>f.host.Id='c'.repeat(64),f=>f.host.Mounts[0].RW=false,f=>f.containers.push({Id:oldId,Mounts:[]}),f=>f.containers.push({Id:'other',Mounts:[{Type:'volume',Name:expected.volume,Source:expected.mountpoint}]}),f=>f.containers.push({Id:'other',Mounts:[{Type:'bind',Source:'/var/lib/docker'}]})]){const f=facts();change(f);assert.throws(()=>validateLocalDockerFacts(f,expected),/LOCAL_DOCKER/);}
});
test('rejects an initially unsafe host mount layout and volume driver options even when self-consistent',()=>{
 for(const change of [f=>f.host.Mounts.push({Type:'bind',Source:'/etc',Destination:'/extra',RW:true}),f=>f.host.Mounts.find(m=>m.Destination==='/input').RW=true,f=>f.host.Mounts.find(m=>m.Destination==='/qiwe-control/docker').RW=true,f=>f.volume.Options={device:'/host',type:'none',o:'bind'}]){const f=facts();change(f);assert.throws(()=>validateLocalDockerFacts(f,{...expected,hostMounts:f.host.Mounts}),/LOCAL_DOCKER/);}
});
test('rejects another container exposing the daemon filesystem root',()=>{
 const f=facts();f.containers.push({Id:'foreign-root-reader',Mounts:[{Type:'bind',Source:'/',Destination:'/host',RW:false}]});
 assert.throws(()=>validateLocalDockerFacts(f,expected),/LOCAL_DOCKER/);
});
test('mount translation admits exact tmp child only and rejects other command, parent, relative or escaped path',()=>{
 assert.deepEqual(translateLocalMounts(['run','-v','/tmp/work/a:/workspace/group:ro'],expected.mountpoint),['run','-v',expected.mountpoint+'/work/a:/workspace/group:ro']);
 for(const args of [['exec','x'],['run','-v','/tmp:/workspace/group'],['run','-v','/tmp/../etc:/workspace/group'],['run','-v','/input/src:/app/src'],['run','-v','relative:/workspace/group']])assert.throws(()=>translateLocalMounts(args,expected.mountpoint),/LOCAL_DOCKER/);
});
