import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';

// Offline model I/O fixture. The default mode provides a reduced bootstrap;
// optional original-shell mode observes startup and leaves main to its caller.
const ipc='/workspace/ipc',events=path.join(ipc,'verification-events.ndjson');
const record=value=>fs.appendFileSync(events,JSON.stringify({pid:process.pid,at:Date.now(),...value})+'\n');
const originalShell=process.env.QIWE_ORIGINAL_SHELL==='1';
let shellEvidence;
if(originalShell){
 const status=pid=>fs.readFileSync('/proc/'+pid+'/status','utf8');
 const command=pid=>fs.readFileSync('/proc/'+pid+'/cmdline','utf8').replaceAll('\0',' ').trim();
 const ownStatus=status(process.pid),rootStatus=status(1),ancestors=[];
 let pid=process.ppid;
 while(pid>0&&ancestors.length<8){const value=status(pid);ancestors.push({pid,command:command(pid),uid:/^Uid:\s+(\d+)/m.exec(value)?.[1]});if(pid===1)break;pid=Number(/^PPid:\s+(\d+)/m.exec(value)?.[1]);}
 const chromium=fs.readdirSync('/proc').filter(name=>/^\d+$/.test(name)).flatMap(name=>{
  try{const cmd=command(name);return cmd.includes('/usr/lib/chromium/chromium')&&cmd.includes('--remote-debugging-port=9222')?[{pid:Number(name),command:cmd,uid:/^Uid:\s+(\d+)/m.exec(status(name))?.[1]}]:[];}catch{return [];}
 });
 const response=await fetch('http://127.0.0.1:9222/json/version',{signal:AbortSignal.timeout(5000)});
 if(!response.ok)throw Error('ORIGINAL_SHELL_CDP_NOT_READY');
 const cdp=await response.json();
 shellEvidence={ancestors,chromium,cdp,mainEffectiveCaps:/^CapEff:\s+(\w+)/m.exec(ownStatus)?.[1],shellEffectiveCaps:/^CapEff:\s+(\w+)/m.exec(rootStatus)?.[1],noNewPrivileges:/^NoNewPrivs:\s+(\d+)/m.exec(ownStatus)?.[1],
  helpers:Object.fromEntries(['entrypoint.sh','session-generated-paths.mjs','session-permissions-mount.mjs','session-permissions-watcher.mjs','session-permissions.sh','session-prompts-copy.mjs'].map(name=>[name,createHash('sha256').update(fs.readFileSync('/app/'+name)).digest('hex')])),
  compiledEntry:'/tmp/dist/pi-index.js',mainCommand:command(process.pid),piVersion:JSON.parse(fs.readFileSync('/app/node_modules/@earendil-works/pi-coding-agent/package.json','utf8')).version};
 if(process.getuid()!==1000||process.getgid()!==1000||BigInt('0x'+shellEvidence.mainEffectiveCaps)!==0n||BigInt('0x'+shellEvidence.shellEffectiveCaps)!==235n||shellEvidence.noNewPrivileges!=='1'||!ancestors.some(item=>item.pid===1&&item.command.includes('/app/entrypoint.sh'))||!ancestors.some(item=>item.command.includes('runuser -u node'))||!chromium.some(item=>item.uid==='1000')||!/^Chrome\//.test(cdp.Browser)||!shellEvidence.mainCommand.includes('/tmp/dist/pi-index.js'))throw Error('ORIGINAL_SHELL_CHAIN_NOT_PROVEN');
}
record({type:'bootstrap',uid:process.getuid(),gid:process.getgid(),hostname:process.env.HOSTNAME,
 providerHash:createHash('sha256').update(fs.readFileSync(new URL(import.meta.url))).digest('hex'),
 entryHash:createHash('sha256').update(fs.readFileSync(originalShell?'/tmp/dist/pi-index.js':'/app/dist/pi-index.js')).digest('hex'),
 socketPresent:fs.existsSync('/var/run/docker.sock'),projectPresent:fs.existsSync('/workspace/project'),
 originalShellExecuted:originalShell,chromiumExecuted:originalShell,identityBridgeExecuted:originalShell,shellEvidence});
if(!originalShell){
fs.mkdirSync('/home/node/.claude/skills',{recursive:true});
for(const id of fs.readdirSync('/workspace/effective-skills')){
 const target='/home/node/.claude/skills/'+id;
 if(fs.existsSync(target))fs.rmSync(target,{recursive:true});
 fs.symlinkSync('/workspace/effective-skills/'+id,target);
}
}
record({type:'sdk-loading'});
let ModelRuntime;
try{({ModelRuntime}=await import('/app/node_modules/@earendil-works/pi-coding-agent/dist/index.js'));record({type:'sdk-ready'});}
catch(error){record({type:'sdk-error',error:String(error),stack:error?.stack});throw error;}
ModelRuntime.prototype.streamSimple=function(model,context,options){
 const latest=context.messages.findLastIndex(message=>message.role==='user');
 const userText=JSON.stringify(context.messages[latest]);
 const kind=userText.includes('[hold-interrupt]')?'interrupt':userText.includes('[hold-drain]')?'drain':'normal';
 const results=context.messages.slice(latest+1).filter(message=>message.role==='toolResult');
 record({type:'provider',kind,messages:context.messages,tools:context.tools?.map(tool=>tool.name)});
 const resultText=id=>results.find(result=>result.toolCallId===id)?.content.map(part=>part.text??'').join('')??'';
 const ids=['approved','skill','forbidden-project','forbidden-user'];
 const exactResults=results.length===4&&ids.every(id=>results.filter(result=>result.toolCallId===id).length===1);
 const success=id=>results.find(result=>result.toolCallId===id)?.isError!==true;
 const expectedSkill=fs.readFileSync('/workspace/effective-skills/beauty-local-content/SKILL.md','utf8').trim();
 const content=results.length===0?[
  {type:'toolCall',id:'approved',name:'read',arguments:{path:'approved.txt'}},
  {type:'toolCall',id:'skill',name:'read',arguments:{path:'/home/node/.claude/skills/beauty-local-content/SKILL.md'}},
  {type:'toolCall',id:'forbidden-project',name:'read',arguments:{path:'/workspace/project/private.txt'}},
  {type:'toolCall',id:'forbidden-user',name:'read',arguments:{path:'/workspace/other-user/private.txt'}},
 ]:[{type:'text',text:JSON.stringify({tag:'synthetic-real-container-answer',approved:resultText('approved'),skillRead:exactResults&&success('approved')&&success('skill')&&resultText('skill').trim()===expectedSkill,
  denied:exactResults&&['forbidden-project','forbidden-user'].every(id=>results.find(result=>result.toolCallId===id)?.isError===true),
  priorAnswer:context.messages.slice(0,latest).some(message=>message.role==='assistant'&&JSON.stringify(message.content).includes('synthetic-real-container-answer'))})}];
 const message={role:'assistant',content,api:model.api,provider:model.provider,model:model.id,
  usage:{input:0,output:0,cacheRead:0,cacheWrite:0,totalTokens:0,cost:{input:0,output:0,cacheRead:0,cacheWrite:0,total:0}},stopReason:results.length?'stop':'toolUse',timestamp:Date.now()};
 const finish=(async()=>{
  if(!results.length&&kind!=='normal'){
   record({type:'held',kind});
   await new Promise(resolve=>{
    const release=()=>{clearInterval(timer);options.signal?.removeEventListener('abort',abort);resolve();};
    const abort=()=>{record({type:'aborted',kind});release();};
    const timer=setInterval(()=>{if(fs.existsSync(path.join(ipc,'release-'+kind)))release();},20);
    options.signal?.addEventListener('abort',abort,{once:true});if(options.signal?.aborted)abort();
   });
  }
  if(options.signal?.aborted){message.content=[];message.stopReason='aborted';message.errorMessage='Synthetic provider observed real SDK AbortSignal';}
  return message;
 })();
 return {async *[Symbol.asyncIterator](){await finish;yield message.stopReason==='aborted'?{type:'error',reason:'aborted',error:message}:{type:'done',reason:message.stopReason,message};},result:()=>finish};
};
if(!originalShell)await import('/app/dist/pi-index.js');
