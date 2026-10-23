import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';

export interface RestorationBoundaryReceipt {
 version:1;runId:string;issuedAt:string;
 supervisor:{pid:1;startTime:string;scriptPath:string;scriptSha256:string;modulePath:string;moduleSha256:string};
 hostRoot:{path:string;dev:string;ino:string};dataRoot:{path:string;dev:string;ino:string};
 namespaces:{pid:string;net:string;mnt:string};
 oldWriters:Array<{pid:number;startTime:string;exitCode:number|null;signal:string|null;capability:{dbPath:string;ipcPath:string};writeObservedSha256:string}>;
}
const sha=(value:string|Buffer)=>createHash('sha256').update(value).digest('hex');
const proc=(pid:number)=>{
 const value=fs.readFileSync(`/proc/${pid}/stat`,'utf8');
 const rest=value.slice(value.lastIndexOf(')')+2).split(' ');
 return {parent:Number(rest[1]),startTime:rest[19]};
};
const fail=()=>{throw Error('RESTORATION_BOUNDARY_UNVERIFIED');};

/** Local Linux supervisor boundary only. Receipt authority is the pinned
 * supervisor executable plus its observed process/mount namespace, not JSON
 * claiming it is safe. This is not a production process fencing mechanism. */
export function inspectRestorationBoundary(dataDir:string,supervisorHash:string,supervisorModuleHash:string):{version:string;evidence:string[]} {
 if(process.platform!=='linux'||!/^[a-f0-9]{64}$/.test(supervisorHash)||!/^[a-f0-9]{64}$/.test(supervisorModuleHash))return fail();
 const locator=process.env.QIWE_RESTORATION_RECEIPT;
 if(!locator||!/^\/proc\/1\/fd\/\d+$/.test(locator))return fail();
 const fdNumber=locator.slice(locator.lastIndexOf('/')+1);
 const fdInfo=fs.readFileSync('/proc/1/fdinfo/'+fdNumber,'utf8');
 const flags=fdInfo.match(/^flags:\s+([0-7]+)$/m);
 if(!flags||(parseInt(flags[1]!,8)&3)!==0)return fail();
 const stat=fs.statSync(locator,{bigint:true});
 if(!stat.isFile()||stat.nlink!==0n||stat.size<=0n||stat.size>65536n)return fail();
 const raw=fs.readFileSync(locator,'utf8');
 const receipt:RestorationBoundaryReceipt=JSON.parse(raw);
 if(receipt.version!==1||typeof receipt.runId!=='string'||!receipt.runId||receipt.supervisor?.pid!==1||
  receipt.supervisor.scriptSha256!==supervisorHash||sha(fs.readFileSync(receipt.supervisor.scriptPath))!==supervisorHash||
  proc(1).startTime!==receipt.supervisor.startTime)return fail();
 if(receipt.supervisor.modulePath!==path.join(path.dirname(receipt.supervisor.scriptPath),'full-host-restoration-supervisor.mjs')||
  receipt.supervisor.moduleSha256!==supervisorModuleHash||sha(fs.readFileSync(receipt.supervisor.modulePath))!==supervisorModuleHash)return fail();
 const command=fs.readFileSync('/proc/1/cmdline','utf8').split('\0').filter(Boolean);
 if(!command.some(argument=>path.isAbsolute(argument)&&path.resolve(argument)===receipt.supervisor.scriptPath))return fail();
 const supervisorStatus=fs.readFileSync('/proc/1/status','utf8');
 if(!/^CapEff:\s+0+$/m.test(supervisorStatus)||!/^NoNewPrivs:\s+1$/m.test(supervisorStatus))return fail();
 const ancestorPids=new Set<number>([1]);let pid=process.pid;
 for(let depth=0;pid!==1&&depth<32;depth++){
  if(ancestorPids.has(pid))return fail();ancestorPids.add(pid);pid=proc(pid).parent;
  if(pid<1)return fail();
 }
 if(pid!==1)return fail();
 for(const name of ['pid','net','mnt'] as const){
  if(fs.readlinkSync(`/proc/self/ns/${name}`)!==receipt.namespaces[name]||fs.readlinkSync(`/proc/1/ns/${name}`)!==receipt.namespaces[name])return fail();
 }
 for(const [root,expected] of [[process.cwd(),receipt.hostRoot],[dataDir,receipt.dataRoot]] as const){
  if(!expected||path.resolve(root)!==expected.path||fs.realpathSync(root)!==expected.path)return fail();
  const current=fs.statSync(root,{bigint:true});
  if(!current.isDirectory()||String(current.dev)!==expected.dev||String(current.ino)!==expected.ino)return fail();
 }
 const mounts=fs.readFileSync('/proc/self/mountinfo','utf8').trim().split('\n').map(line=>{
  const [left,right]=line.split(' - '),fields=left!.split(' '),type=right!.split(' ')[0];
  return {mount:fields[4]!,options:fields[5]!.split(','),type};
 });
 const containing=(target:string)=>mounts.filter(row=>target===row.mount||target.startsWith(row.mount==='/'?'/':row.mount+'/')).sort((a,b)=>b.mount.length-a.mount.length)[0];
 if(!mounts.find(row=>row.mount==='/'&&row.options.includes('ro'))||containing(dataDir)?.type!=='tmpfs'||
  !containing(receipt.supervisor.scriptPath)?.options.includes('ro')||!containing(receipt.supervisor.modulePath)?.options.includes('ro'))return fail();
 if(fs.existsSync('/var/run/docker.sock')||fs.existsSync('/run/docker.sock'))return fail();
 const interfaces=fs.readFileSync('/proc/net/dev','utf8').split('\n').slice(2).filter(line=>line.includes(':')).map(line=>line.split(':')[0]!.trim());
 if(interfaces.some(name=>name!=='lo'))return fail();
 if(!Array.isArray(receipt.oldWriters)||receipt.oldWriters.length>128)return fail();
 for(const writer of receipt.oldWriters){
  if(!Number.isSafeInteger(writer.pid)||writer.pid<2||typeof writer.startTime!=='string'||
   !(Number.isInteger(writer.exitCode)||typeof writer.signal==='string')||!/^[a-f0-9]{64}$/.test(writer.writeObservedSha256)||
   !writer.capability?.dbPath.startsWith(receipt.hostRoot.path+'/')||!writer.capability.ipcPath.startsWith(dataDir+'/ipc/'))return fail();
  if(fs.existsSync(`/proc/${writer.pid}/stat`)&&proc(writer.pid).startTime===writer.startTime)return fail();
 }
 // The fixed local harness permits only the supervisor and the current test
 // process ancestor chain. An untracked sibling/old runner closes restoration.
 for(const entry of fs.readdirSync('/proc'))if(/^\d+$/.test(entry)&&!ancestorPids.has(Number(entry)))return fail();
 return {version:sha(raw),evidence:['pinned_pid1_supervisor','readonly_unlinked_receipt','same_confined_namespace','observed_old_writer_exit','local_isolated_scope']};
}
