import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {inspectExistingProfileContext} from './full-host-existing-profile.mjs';

const enabled=process.platform==='linux';
function fixture(t){
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'existing-profile-context-')),data=path.join(root,'data');fs.mkdirSync(data);
 t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 const write=relative=>{const file=path.join(data,relative);fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,'synthetic private configuration');return file;};
 return {root,data,write,check:()=>inspectExistingProfileContext(data,'member',['flow-localtest-ab12'])};
}
test('missing plugin and workspace configuration is an absence fact without creating resources',{skip:!enabled},t=>{
 const f=fixture(t);assert.equal(f.check(),true);assert.deepEqual(fs.readdirSync(f.data),[]);
 fs.mkdirSync(path.join(f.data,'plugins/users/member'),{recursive:true});fs.mkdirSync(path.join(f.data,'groups/flow-localtest-ab12/.claude'),{recursive:true});
 assert.equal(f.check(),true);
});
test('existing plugin configuration is refused regardless of its contents or link count',{skip:!enabled},t=>{
 const f=fixture(t),file=f.write('plugins/users/member/plugins.json');assert.equal(f.check(),false);
 fs.linkSync(file,path.join(f.root,'linked'));assert.equal(f.check(),false);
});
for(const relative of ['.mcp.json','.claude/settings.json','.claude/settings.local.json'])test('existing project configuration is refused: '+relative,{skip:!enabled},t=>{
 const f=fixture(t);f.write('groups/flow-localtest-ab12/'+relative);assert.equal(f.check(),false);
});
test('other owners and groups do not substitute for the requested sources',{skip:!enabled},t=>{
 const f=fixture(t);f.write('plugins/users/other/plugins.json');f.write('groups/other/.mcp.json');assert.equal(f.check(),true);
 assert.equal(inspectExistingProfileContext(f.data,'other',['flow-localtest-ab12']),false);
 assert.equal(inspectExistingProfileContext(f.data,'member',['other']),false);
});
test('unsafe identities, folders and relative roots are refused',{skip:!enabled},t=>{
 const f=fixture(t);
 for(const owner of ['', '..','member/other','member\\other'])assert.equal(inspectExistingProfileContext(f.data,owner,['flow-localtest-ab12']),false);
 for(const folder of ['', '..','role/other','role\\other'])assert.equal(inspectExistingProfileContext(f.data,'member',[folder]),false);
 assert.equal(inspectExistingProfileContext('relative','member',['role']),false);
 assert.equal(inspectExistingProfileContext(f.data,'member',[]),false);
});
test('links in the data root, ancestor, owner or group context are refused',{skip:!enabled},t=>{
 const f=fixture(t),outside=path.join(f.root,'outside');fs.mkdirSync(outside);
 const alias=path.join(f.root,'alias');fs.symlinkSync(f.data,alias);assert.equal(inspectExistingProfileContext(alias,'member',['role']),false);
 const through=path.join(f.root,'through');fs.symlinkSync(f.root,through);assert.equal(inspectExistingProfileContext(path.join(through,'data'),'member',['role']),false);
 fs.mkdirSync(path.join(f.data,'plugins/users'),{recursive:true});fs.symlinkSync(outside,path.join(f.data,'plugins/users/member'));assert.equal(f.check(),false);
 fs.unlinkSync(path.join(f.data,'plugins/users/member'));fs.mkdirSync(path.join(f.data,'groups'),{recursive:true});fs.symlinkSync(outside,path.join(f.data,'groups/flow-localtest-ab12'));assert.equal(f.check(),false);
});
test('file creation during an absence check invalidates the observation',{skip:!enabled},t=>{
 const f=fixture(t);fs.mkdirSync(path.join(f.data,'groups/flow-localtest-ab12'),{recursive:true});
 const original=fs.lstatSync;let changed=false;
 try{fs.lstatSync=function(file,...args){try{return original.call(fs,file,...args);}catch(error){if(!changed&&String(file).endsWith('/.mcp.json')){changed=true;f.write('groups/flow-localtest-ab12/.mcp.json');}throw error;}};assert.equal(f.check(),false);assert.equal(changed,true);}finally{fs.lstatSync=original;}
});
test('directory changes during an otherwise absent configuration scan are refused',{skip:!enabled},t=>{
 const f=fixture(t);fs.mkdirSync(path.join(f.data,'groups/flow-localtest-ab12'),{recursive:true});
 const original=fs.lstatSync;let changed=false;
 try{fs.lstatSync=function(file,...args){try{return original.call(fs,file,...args);}catch(error){if(!changed&&String(file).endsWith('/.mcp.json')){changed=true;f.write('groups/flow-localtest-ab12/unrelated');}throw error;}};assert.equal(f.check(),false);assert.equal(changed,true);}finally{fs.lstatSync=original;}
});
test('budget exhaustion fails closed before filesystem probing and during traversal',{skip:!enabled},t=>{
 const f=fixture(t);let calls=0,probes=0;const original=fs.openSync;
 try{fs.openSync=function(...args){probes++;return original.apply(fs,args);};assert.equal(inspectExistingProfileContext(f.data,'member',['flow-localtest-ab12'],()=>{calls++;return false;}),false);assert.equal(calls,1);assert.equal(probes,0);}finally{fs.openSync=original;}
 const descriptors=fs.readdirSync('/proc/self/fd').length;
 let remaining=5;assert.equal(inspectExistingProfileContext(f.data,'member',['flow-localtest-ab12'],()=>--remaining>0),false);
 assert.equal(fs.readdirSync('/proc/self/fd').length,descriptors);
 assert.equal(inspectExistingProfileContext(f.data,'member',['flow-localtest-ab12'],()=>true),true);
});
for(const source of ['member/servers.json','member/secrets.json','system/servers.json'])test('any managed MCP root is outside this local absence proof: '+source,{skip:!enabled},t=>{
 const f=fixture(t);f.write('mcp-servers/'+source);assert.equal(f.check(),false);
});
