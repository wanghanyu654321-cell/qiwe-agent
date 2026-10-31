import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {inspectExistingConfig} from './full-host-existing-config.mjs';

const opts={webSessionSecret:'synthetic-session-secret',pluginAutoScan:false};
const enabled=process.platform==='linux'&&process.getuid?.()===1000&&process.getgid?.()===1000;
function fixture(t,name,contents){
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'frontagent-config-proof-'));const file=path.join(root,name);fs.writeFileSync(file,contents,{mode:0o600});
 const parent=fs.openSync(root,fs.constants.O_RDONLY|fs.constants.O_DIRECTORY|fs.constants.O_NOFOLLOW);
 t.after(()=>{fs.closeSync(parent);fs.rmSync(root,{recursive:true,force:true});});
 return {root,file,parent,relative:'config/'+name,stat:()=>fs.lstatSync(file,{bigint:true})};
}
test('recognizes only the original matching session secret without disclosing it',{skip:!enabled},t=>{
 const f=fixture(t,'session-secret.key','synthetic-session-secret\n');
 const got=inspectExistingConfig(f.parent,f.relative,f.stat(),opts);
 assert.equal(got,'original_loaded_session_secret');assert.ok(!JSON.stringify(got).includes(opts.webSessionSecret));
 assert.equal(inspectExistingConfig(f.parent,f.relative,f.stat(),{...opts,webSessionSecret:'different'}),undefined);
 fs.writeFileSync(f.file,'  \n');assert.equal(inspectExistingConfig(f.parent,f.relative,f.stat(),opts),undefined);
 fs.writeFileSync(f.file,Buffer.from([0xff,0xfe]));assert.equal(inspectExistingConfig(f.parent,f.relative,f.stat(),opts),undefined);
});
test('requires a unique disabled top-level setting and matching effective state',{skip:!enabled},t=>{
 const f=fixture(t,'system-settings.json','{"pluginAutoScan":false,"nested":{"pluginAutoScan":true},"large":9007199254740993}');
 assert.equal(inspectExistingConfig(f.parent,f.relative,f.stat(),opts),'original_disabled_plugin_autoscan');
 for(const body of ['{"pluginAutoScan":true}','{"other":false}','{"pluginAutoScan":false,"pluginAutoScan":false}','{"pluginAutoScan":false,"pluginAuto\\u0053can":false}','{"pluginAutoScan":"false"}','\ufeff{"pluginAutoScan":false}','{']){
  fs.writeFileSync(f.file,body);assert.equal(inspectExistingConfig(f.parent,f.relative,f.stat(),opts),undefined);
 }
 fs.writeFileSync(f.file,'{"pluginAutoScan":false}');assert.equal(inspectExistingConfig(f.parent,f.relative,f.stat(),{...opts,pluginAutoScan:true}),undefined);
});
test('rejects unknown paths, unexpected owners, unsafe links, changed identity and excess sizes',{skip:!enabled},t=>{
 const f=fixture(t,'session-secret.key','synthetic-session-secret');const current=f.stat();
 assert.equal(inspectExistingConfig(f.parent,'config/unknown',current,opts),undefined);
 assert.equal(inspectExistingConfig(f.parent,f.relative,{...current,uid:999n},opts),undefined);
 fs.chmodSync(f.file,0o777);assert.equal(inspectExistingConfig(f.parent,f.relative,f.stat(),opts),undefined);
 fs.chmodSync(f.file,0o600);assert.equal(inspectExistingConfig(f.parent,f.relative,f.stat(),opts),'original_loaded_session_secret');
 fs.chmodSync(f.file,0o622);assert.equal(inspectExistingConfig(f.parent,f.relative,f.stat(),opts),undefined);fs.chmodSync(f.file,0o600);
 fs.chmodSync(f.file,0o640);assert.equal(inspectExistingConfig(f.parent,f.relative,f.stat(),opts),undefined);fs.chmodSync(f.file,0o600);
 fs.linkSync(f.file,path.join(f.root,'extra'));assert.equal(inspectExistingConfig(f.parent,f.relative,f.stat(),opts),undefined);fs.unlinkSync(path.join(f.root,'extra'));
 const before=f.stat();fs.unlinkSync(f.file);fs.symlinkSync('extra',f.file);assert.equal(inspectExistingConfig(f.parent,f.relative,before,opts),undefined);
 fs.unlinkSync(f.file);fs.writeFileSync(f.file,'x'.repeat(131073),{mode:0o600});assert.equal(inspectExistingConfig(f.parent,f.relative,f.stat(),opts),undefined);
});
test('detects mutation while reading',{skip:!enabled},t=>{
 const f=fixture(t,'session-secret.key','synthetic-session-secret');const before=f.stat(),read=fs.readFileSync;
 try{fs.readFileSync=function(target,...args){const bytes=read.call(fs,target,...args);if(typeof target==='number')fs.writeFileSync(f.file,'replaced-secret');return bytes;};assert.equal(inspectExistingConfig(f.parent,f.relative,before,opts),undefined);}finally{fs.readFileSync=read;}
});
