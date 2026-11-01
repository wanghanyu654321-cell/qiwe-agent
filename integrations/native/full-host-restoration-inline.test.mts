import {afterEach,expect,test,vi} from 'vitest';
import {EventEmitter} from 'node:events';

afterEach(()=>{vi.unstubAllEnvs();vi.resetModules();});

test('member-container-only refuses host inline commands before the physical spawn seam',async()=>{
 vi.stubEnv('MINICLAW_EXECUTION_BOUNDARY','member-container-only');vi.resetModules();
 const {executeInlineBashHost}=await import('../src/plugin-inline-bash.js');
 const spawnFn=vi.fn(()=>{throw Error('physical host shell reached');});
 const result=await executeInlineBashHost('printf forbidden',[],{CLAUDE_PLUGIN_ROOT:'/unused',ARGUMENTS:''},'/unused',{spawnImpl:spawnFn as never});
 expect(result.ok).toBe(false);
 expect(result.stderr).toBe('business_execution_forbidden:host-inline');
 expect(result.exitCode).toBeNull();
 expect(spawnFn).not.toHaveBeenCalled();
});

test('original boundary preserves the original host inline invocation and result',async()=>{
 vi.stubEnv('MINICLAW_EXECUTION_BOUNDARY','original');vi.resetModules();
 const {executeInlineBashHost}=await import('../src/plugin-inline-bash.js');
 const spawnFn=vi.fn(()=>{
  const child=Object.assign(new EventEmitter(),{stdout:new EventEmitter(),stderr:new EventEmitter(),kill:vi.fn()});
  queueMicrotask(()=>{child.stdout.emit('data',Buffer.from('legacy output'));child.emit('close',0,null);});
  return child;
 });
 const result=await executeInlineBashHost('printf legacy',['one'],{CLAUDE_PLUGIN_ROOT:'/plugin',ARGUMENTS:'one'},'/workspace',{spawnImpl:spawnFn as never});
 expect(result.ok).toBe(true);expect(result.stdout).toBe('legacy output');
 expect(spawnFn).toHaveBeenCalledTimes(1);
 expect(spawnFn.mock.calls[0]?.slice(0,2)).toEqual(['bash',['-c','printf legacy','--','one']]);
});
