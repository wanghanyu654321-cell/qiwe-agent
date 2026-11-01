import {afterEach,it,expect} from 'vitest';
import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import {spawn,type ChildProcess} from 'node:child_process';
import {WorkbenchAccessStore,type WorkbenchGrant} from '../../src/role-eval/workbench-access.js';
import {createWecomBotContext} from '../../src/role-eval/wecom-bot-context.js';
const cleanups:(()=>void|Promise<void>)[]=[];
afterEach(async()=>{for(const close of cleanups.splice(0).reverse())await close();});
// The child owns a real SQLite write lock. It commits only after the parent's
// withCurrent entry explicitly releases it; no sleeps guess when to start work.
const locker=`import {DatabaseSync} from 'node:sqlite';
const [file,mode,delay]=process.argv.slice(1),db=new DatabaseSync(file);
db.exec('BEGIN IMMEDIATE');
if(mode==='revoke'){const row=db.prepare('SELECT body FROM workbench_grants WHERE account=?').get('a');const grant=JSON.parse(row.body);grant.active=false;grant.version++;db.prepare('UPDATE workbench_grants SET body=? WHERE account=?').run(JSON.stringify(grant),'a');}
process.stdout.write('locked\\n');
let released=false;process.stdin.on('data',()=>{if(released)return;released=true;setTimeout(()=>{db.exec('COMMIT');db.close();process.stdout.write('committed\\n');process.exit(0);},Number(delay));});
setTimeout(()=>{try{db.exec('ROLLBACK');db.close();}catch{}process.exit(2);},6000).unref();`;
async function fixture(mode:'revoke'|'hold',delay:number){
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'qiwe-contention-'));cleanups.push(()=>fs.rmSync(dir,{recursive:true,force:true}));
 const file=path.join(dir,'grants.sqlite'),store=new WorkbenchAccessStore(file);cleanups.push(()=>store.close());
 store.change('admin',{accountId:'a',storeId:'b',roles:['manager'],active:true,expectedVersion:0,requestKey:'open'});
 const authority=createWecomBotContext({mode:'isolated-synthetic',botId:'bot',corpId:'corp',tenantId:'tenant',stores:[{id:'b'}],roles:['manager'],store,readSubject:async()=>({botId:'bot',memberId:'member-a'}),readBinding:async()=>({corpId:'corp',botId:'bot',memberId:'member-a',accountId:'a',active:true,version:1}),readNative:async()=>({user:{id:'a',role:'member',status:'active',must_change_password:false},workspaceJid:'web:home-a'})});cleanups.push(()=>authority.close());
 const child=spawn(process.execPath,['--input-type=module','-e',locker,'--',file,mode,String(delay)],{stdio:['pipe','pipe','pipe'],windowsHide:true});
 let output='',errors='';child.stdout.on('data',chunk=>{output+=String(chunk);});child.stderr.on('data',chunk=>{errors+=String(chunk);});
 const ended=new Promise<number|null>((resolve,reject)=>{child.once('error',reject);child.once('close',resolve);});
 cleanups.push(async()=>{if(child.exitCode===null&&!child.killed)child.kill();await ended;});
 await new Promise<void>((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('synthetic_lock_not_ready: '+errors)),5000);const ready=()=>{if(output.includes('locked\n')){clearTimeout(timer);child.stdout.off('data',ready);resolve();}};child.stdout.on('data',ready);ready();child.once('error',e=>{clearTimeout(timer);reject(e);});});
 let entered=false;const original=store.withCurrent.bind(store);
 store.withCurrent=<T>(grant:WorkbenchGrant,work:()=>T):T=>{entered=true;child.stdin.write('release\n');return original(grant,work);};
 return {store,authority,ended,entered:()=>entered,output:()=>output,child:child as ChildProcess};
}
it('does not execute a stale employee callback after another process commits revocation while it waits for the grant lock',async()=>{
 const s=await fixture('revoke',100),context=await s.authority.authorize({correlationId:'revoke-lock',signal:new AbortController().signal,deadline:performance.now()+3000},'manager');let writes=0;
 await expect(s.authority.withCurrent(context,()=>++writes)).rejects.toThrow('access_changed');expect(s.entered()).toBe(true);expect(writes).toBe(0);expect(await s.ended).toBe(0);expect(s.output()).toContain('committed');expect(s.store.get('a')).toMatchObject({active:false,version:2});
});
it('rolls back without calling business work when a synchronous SQLite lock wait consumes the request budget',async()=>{
 const s=await fixture('hold',650),context=await s.authority.authorize({correlationId:'budget-lock',signal:new AbortController().signal,deadline:performance.now()+300},'manager');let writes=0;
 await expect(s.authority.withCurrent(context,()=>++writes)).rejects.toThrow('authority_timeout');expect(s.entered()).toBe(true);expect(writes).toBe(0);expect(await s.ended).toBe(0);expect(s.store.get('a')).toMatchObject({active:true,version:1});
 // Busy waits are synchronous, so this proves no late write, not a latency SLA.
});
