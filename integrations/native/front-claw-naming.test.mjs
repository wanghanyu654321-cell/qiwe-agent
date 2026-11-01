import test from 'node:test';
import assert from 'node:assert/strict';
import {frontClawName,frontClawArgs} from './real-container-boundary.mjs';

test('Front Claw naming translates legacy upstream container names into the frontclaw prefix',()=>{
 assert.equal(frontClawName('miniclaw-marketing-123','frontclaw-marketing-'),'frontclaw-marketing-123');
 assert.equal(frontClawName('frontclaw-marketing-123','frontclaw-marketing-'),'frontclaw-marketing-123');
 assert.equal(frontClawName('miniclaw-ads-1','frontclaw-marketing-'),'miniclaw-ads-1');
 assert.deepEqual(frontClawArgs(['run','-i','--rm','--name','miniclaw-marketing-9'],'frontclaw-marketing-'),['run','-i','--rm','--name','frontclaw-marketing-9']);
});