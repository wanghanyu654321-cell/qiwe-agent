import {expect,vi} from 'vitest';
import net from 'node:net';
import dns from 'node:dns';
import dgram from 'node:dgram';
import childProcess from 'node:child_process';
import {syncBuiltinESMExports} from 'node:module';

/** Same boundaries as the existing actual-main fixture; only its exact HTTP
 * listeners may be reached, and subprocess/model transport cannot escape. */
export function installRestorationIsolation(){
 const originalTimeout=globalThis.setTimeout,originalInterval=globalThis.setInterval;
 const timers:any[]=[],intervals:any[]=[],servers:net.Server[]=[],blocked:string[]=[],exits:number[]=[];
 vi.spyOn(globalThis,'setTimeout').mockImplementation(((...args:any[])=>{const timer=(originalTimeout as any)(...args);timers.push(timer);return timer;}) as any);
 vi.spyOn(globalThis,'setInterval').mockImplementation(((...args:any[])=>{const timer=(originalInterval as any)(...args);intervals.push(timer);return timer;}) as any);
 const connect=net.Socket.prototype.connect,listen=net.Server.prototype.listen;
 vi.spyOn(net.Socket.prototype,'connect').mockImplementation(function(this:net.Socket,...args:any[]){
  const raw=Array.isArray(args[0])?args[0]:args,first=raw[0],host=typeof first==='object'?first.host:typeof raw[1]==='string'?raw[1]:'localhost',port=Number(typeof first==='object'?first.port:first);
  if(typeof first==='object'&&first.path||typeof first==='string'||host!=='127.0.0.1'||!servers.some(server=>{const address=server.address();return address&&typeof address==='object'&&address.address===host&&address.port===port;})){blocked.push('tcp');throw Error('RESTORATION_NETWORK_FORBIDDEN');}
  return (connect as any).apply(this,args);
 } as any);
 vi.spyOn(net.Server.prototype,'listen').mockImplementation(function(this:net.Server,...args:any[]){
  const first=args[0],port=typeof first==='number'?first:first?.port;
  if(!Number.isSafeInteger(port)||port<0||port>65535||first?.path||first?.fd!==undefined){blocked.push('listen');throw Error('RESTORATION_LISTEN_FORBIDDEN');}
  if(typeof first==='number'){args[0]={port:first,host:'127.0.0.1'};if(typeof args[1]==='string')args.splice(1,1);}else args[0]={...first,host:'127.0.0.1'};
  servers.push(this);return (listen as any).apply(this,args);
 } as any);
 const lookup=dns.lookup,promiseLookup=dns.promises.lookup;
 vi.spyOn(dns,'lookup').mockImplementation(((hostname:string,...args:any[])=>{if(!['127.0.0.1','::1'].includes(hostname)){blocked.push('dns');throw Error('RESTORATION_DNS_FORBIDDEN');}return (lookup as any)(hostname,...args);}) as any);
 vi.spyOn(dns.promises,'lookup').mockImplementation(((hostname:string,...args:any[])=>{if(!['127.0.0.1','::1'].includes(hostname)){blocked.push('dns');throw Error('RESTORATION_DNS_FORBIDDEN');}return (promiseLookup as any)(hostname,...args);}) as any);
 for(const surface of [dns,dns.promises])for(const name of Object.keys(surface).filter(name=>name.startsWith('resolve')||name==='reverse'||name==='lookupService'))vi.spyOn(surface,name as any).mockImplementation((()=>{blocked.push('dns');throw Error('RESTORATION_DNS_FORBIDDEN');}) as any);
 for(const name of ['send','connect','bind'])vi.spyOn(dgram.Socket.prototype,name as any).mockImplementation((()=>{blocked.push('udp');throw Error('RESTORATION_UDP_FORBIDDEN');}) as any);
 for(const name of ['exec','execFile','execSync','execFileSync','spawn','spawnSync','fork'])vi.spyOn(childProcess,name as any).mockImplementation((()=>{blocked.push('child');throw Error('RESTORATION_CHILD_FORBIDDEN');}) as any);
 vi.spyOn(process,'exit').mockImplementation(((code:number)=>{exits.push(code);}) as any);syncBuiltinESMExports();
 const probe=new net.Socket();for(const target of [{host:'192.0.2.1',port:443},{host:'::1',port:443},{host:'127.0.0.1',port:65534},{path:'/synthetic-denied.sock'},{path:'\\\\.\\pipe\\synthetic-denied'}])expect(()=>probe.connect(target as any)).toThrow('RESTORATION_NETWORK_FORBIDDEN');
 expect(()=>net.createServer().listen('/synthetic-denied.sock')).toThrow('RESTORATION_LISTEN_FORBIDDEN');
 expect(()=>dns.resolve('synthetic.invalid',()=>{})).toThrow('RESTORATION_DNS_FORBIDDEN');
 const udp=dgram.createSocket('udp4');expect(()=>udp.send('synthetic',1,'192.0.2.1')).toThrow('RESTORATION_UDP_FORBIDDEN');udp.close();
 expect(()=>childProcess.spawn('synthetic')).toThrow('RESTORATION_CHILD_FORBIDDEN');blocked.length=0;
 return {servers,blocked,exits,wait:async(predicate:()=>boolean,label:string)=>{for(let count=0;count<200&&!predicate();count++)await new Promise(resolve=>originalTimeout(resolve,25));expect(predicate(),label).toBe(true);},
  close(){for(const timer of timers)clearTimeout(timer);for(const timer of intervals)clearInterval(timer);process.removeAllListeners('SIGTERM');process.removeAllListeners('SIGINT');vi.restoreAllMocks();syncBuiltinESMExports();}};
}
