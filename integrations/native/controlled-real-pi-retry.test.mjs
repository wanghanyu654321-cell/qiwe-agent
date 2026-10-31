import {test} from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import * as trial from './controlled-real-pi-retry.mjs';

const anchor=`    const settingsManager = SettingsManager.create(options.cwd, agentDir, {
      projectTrusted: true,
    });`;

test('changes only this runtime settings instance, without writing or changing unrelated settings',()=>{
 const source=anchor+'\n    return settingsManager;';
 const transformed=trial.disableControlledRealPiRetries(source);
 const manager={getRetryEnabled:()=>true,getRetrySettings:()=>({enabled:true,maxRetries:3,baseDelayMs:9}),getProviderRetrySettings:()=>({timeoutMs:25,maxRetries:2,maxRetryDelayMs:8})};
 const unchanged={getRetryEnabled:()=>true,getRetrySettings:()=>({enabled:true,maxRetries:3}),getProviderRetrySettings:()=>({maxRetries:2})};
 const fn=new vm.Script(`(function(SettingsManager, options, agentDir){${transformed}})` ).runInNewContext();
 assert.equal(fn({create:()=>manager},{cwd:'/'},'/agent'),manager);
 assert.equal(manager.getRetryEnabled(),false);
 assert.equal(JSON.stringify(manager.getRetrySettings()),JSON.stringify({enabled:false,maxRetries:0,baseDelayMs:9}));
 assert.equal(JSON.stringify(manager.getProviderRetrySettings()),JSON.stringify({timeoutMs:25,maxRetries:0,maxRetryDelayMs:8}));
 assert.equal(unchanged.getRetryEnabled(),true);assert.equal(unchanged.getRetrySettings().maxRetries,3);
});

test('fails closed for changed or ambiguous original source and retains CRLF input',()=>{
 assert.throws(()=>trial.disableControlledRealPiRetries('changed'),/CONTROLLED_REAL_PI_RETRY/);
 assert.throws(()=>trial.disableControlledRealPiRetries(anchor+anchor),/CONTROLLED_REAL_PI_RETRY/);
 const crlf=anchor.replaceAll('\n','\r\n');
 assert.match(trial.disableControlledRealPiRetries(crlf),/getProviderRetrySettings/);
 assert.equal(trial.disableControlledRealPiRetries(crlf).replaceAll('\r\n','').includes('\n'),false);
});
