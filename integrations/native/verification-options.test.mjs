import assert from 'node:assert/strict';import test from 'node:test';import path from 'node:path';
import {nativeVerificationOptions} from './verification-options.mjs';
const source=path.resolve('synthetic-source'),driver=path.resolve('synthetic-driver'),overlay=path.resolve('synthetic-overlay');
test('captures explicit local verification modes and their paths',()=>{
 assert.deepEqual(nativeVerificationOptions([source,'--sqlite-driver',driver,'--host-overlay',overlay,'--typecheck']),{source,driver,overlay,typecheck:true,unpatched:false});
 assert.deepEqual(nativeVerificationOptions([source]),{source,driver:undefined,overlay:undefined,typecheck:false,unpatched:false});
});
test('fails closed on unknown, duplicate, missing or relative option values',()=>{
 for(const args of [[source,'--other'],[source,'--sqlite-driver'],[source,'--sqlite-driver','relative'],[source,'--typecheck','--typecheck'],[source,'--sqlite-driver',driver,'--sqlite-driver',driver],['relative'],[]])assert.throws(()=>nativeVerificationOptions(args),/Invalid Native verification arguments/);
});
test('never silently combines an unpatched baseline with a host candidate',()=>{
 assert.throws(()=>nativeVerificationOptions([source,'--unpatched','--host-overlay',overlay]),/Invalid Native verification arguments/);
 assert.equal(nativeVerificationOptions([source,'--unpatched']).unpatched,true);
});
