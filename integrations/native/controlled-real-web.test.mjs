import {test} from 'node:test';
import assert from 'node:assert/strict';
import {restrictPilotWebLoopback} from './controlled-real-web.mjs';

test('controlled trial binds original web server to loopback without changing its port or handler',()=>{
 const input='httpServer = serve(\n    {\n      fetch: app.fetch,\n      port: WEB_PORT,\n    },';
 assert.equal(restrictPilotWebLoopback(input),input.replace('      port: WEB_PORT,','      port: WEB_PORT,\n      hostname: \'127.0.0.1\','));
});
test('fails closed if original server anchor is absent or ambiguous',()=>{
 const anchor='httpServer = serve(\n    {\n      fetch: app.fetch,\n      port: WEB_PORT,';
 assert.throws(()=>restrictPilotWebLoopback('changed'),/CONTROLLED_REAL_WEB/);
 assert.throws(()=>restrictPilotWebLoopback(anchor+anchor),/CONTROLLED_REAL_WEB/);
});
