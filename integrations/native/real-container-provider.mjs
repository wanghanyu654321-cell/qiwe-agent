import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';

// Reduced offline bootstrap: deliberately does not claim to execute the
// production shell, Chromium, runuser or permission bridge.
const ipc='/workspace/ipc',events=path.join(ipc,'verification-events.ndjson');
const record=value=>fs.appendFileSync(events,JSON.stringify({pid:process.pid,at:Date.now(),...value})+'\n');
record({type:'bootstrap',uid:process.getuid(),gid:process.getgid(),hostname:process.env.HOSTNAME,
 providerHash:createHash('sha256').update(fs.readFileSync(new URL(import.meta.url))).digest('hex'),
 entryHash:createHash('sha256').update(fs.readFileSync('/app/dist/pi-index.js')).digest('hex'),
 socketPresent:fs.existsSync('/var/run/docker.sock'),projectPresent:fs.existsSync('/workspace/project'),
 originalShellExecuted:false,chromiumExecuted:false,identityBridgeExecuted:false});
fs.mkdirSync('/home/node/.claude/skills',{recursive:true});
for(const id of fs.readdirSync('/workspace/effective-skills')){
 const target='/home/node/.claude/skills/'+id;
 if(fs.existsSync(target))fs.rmSync(target,{recursive:true});
 fs.symlinkSync('/workspace/effective-skills/'+id,target);
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
await import('/app/dist/pi-index.js');
