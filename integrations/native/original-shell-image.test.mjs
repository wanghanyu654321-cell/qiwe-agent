import {test} from 'node:test';
import assert from 'node:assert/strict';
import * as boundary from './real-container-boundary.mjs';

test('image preflight rejects wrong digest, entrypoint, source helpers and Pi version',()=>{
 const image='sha256:'+'a'.repeat(64),files={'entrypoint.sh':'b'.repeat(64),'session-permissions.sh':'c'.repeat(64)};
 const inspection={Id:image,Config:{Entrypoint:['/app/entrypoint.sh'],Cmd:null}};
 const probe={files,piVersion:'0.84.2',piAiVersions:{topLevel:'0.84.2',nested:'0.84.2'}};
 assert.deepEqual(boundary.validateOriginalShellImage(inspection,probe,{image,files}).entrypoint,['/app/entrypoint.sh']);
 for(const wrong of [{...inspection,Id:'sha256:'+'d'.repeat(64)},{...inspection,Config:{Entrypoint:['node']} }])assert.throws(()=>boundary.validateOriginalShellImage(wrong,probe,{image,files}),/ORIGINAL_SHELL_IMAGE/);
 for(const wrong of [{...probe,piVersion:'0.84.3'},{...probe,files:{...files,'entrypoint.sh':'d'.repeat(64)}},{...probe,files:{}}])assert.throws(()=>boundary.validateOriginalShellImage(inspection,wrong,{image,files}),/ORIGINAL_SHELL_(SOURCE|PI)/);
});

test('preflight rejects reproduced top-level pi-ai 1.4.0 drift and missing nested version',()=>{
 const image='sha256:'+'a'.repeat(64),inspection={Id:image,Config:{Entrypoint:['/app/entrypoint.sh'],Cmd:null}},files={};
 for(const piAiVersions of [{topLevel:'1.4.0',nested:'0.84.2'},{topLevel:'0.84.2',nested:'1.4.0'},{topLevel:'0.84.2'},undefined]){
  assert.throws(()=>boundary.validateOriginalShellImage(inspection,{files,piVersion:'0.84.2',piAiVersions},{image,files}),/ORIGINAL_SHELL_PI_AI_VERSION/);
 }
});
