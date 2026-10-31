import fs from 'node:fs';
import {createHash} from 'node:crypto';
import {admitPiSessionBeyondSyntheticProtocol} from './pi-session-recovery.mjs';
const skills=['beauty-local-content','vendor-content-strategy','vendor-copywriting'];
const defaultFolder='synthetic-restoration-role';
const safeFolder=value=>typeof value==='string'&&/^[a-z0-9][a-z0-9_-]{0,127}$/.test(value);
const contextFolder=context=>{
 const folder=Array.isArray(context)&&context[0]?.folder;
 return safeFolder(folder)&&context.every(item=>item?.folder===folder&&typeof item.sessionId==='string'&&typeof item.content==='string')?folder:undefined;
};
const knownFile=(relative,folder)=>{const root=`sessions/${folder}/.claude/`;return ['.miniclaw-native-settings.json','agent/auth.json','agent/models-store.json','agent/settings.json','settings.json'].some(p=>relative===root+p)||
 relative===`env/${folder}/default/main/env`||relative==='config/container-claude-json.json'||relative.startsWith(root+'sessions/')&&/^\d{4}-\d\d-\d\dT[\d-Z]+_[-a-f0-9]{36}\.jsonl$/.test(relative.slice((root+'sessions/').length));};
const keys=(value,allowed)=>value&&typeof value==='object'&&!Array.isArray(value)&&Object.keys(value).every(k=>allowed.includes(k));
const exact=(value,expected)=>JSON.stringify(value,Object.keys(expected).sort())===JSON.stringify(expected,Object.keys(expected).sort())&&keys(value,Object.keys(expected));
const textParts=value=>Array.isArray(value)&&value.length>0&&value.every(part=>keys(part,['type','text'])&&part.type==='text'&&typeof part.text==='string');
const time=value=>typeof value==='string'&&Number.isFinite(Date.parse(value));
const escapeXml=value=>value.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
export function settledLocalSessions(rows,records,folder=defaultFolder){
 if(!safeFolder(folder))return [];
 const all=table=>rows.get(table)??[],answer=[];
 for(const {table,row,record} of records){
  if(table!=='wecom_conversation_results'||!record.evidence.includes('d5_frozen_result_verified')||typeof row.session_id!=='string'||typeof row.content!=='string')continue;
  const execution=all('wecom_conversation_execution').find(e=>e.receipt_id===row.receipt_id&&e.state==='completed'&&e.session_id===row.session_id&&e.query_id===row.query_id&&e.turn_id===row.turn_id);
  const group=execution&&all('registered_groups').find(g=>g.jid===execution.workspace_jid&&g.folder===folder&&g.execution_mode==='container');
  if(!group||!all('sessions').some(s=>s.group_folder===folder&&s.session_id===row.session_id)&&!all('workspace_runtime_sessions').some(s=>s.group_folder===folder&&s.sdk_session_id===row.session_id))continue;
  let ids;try{ids=JSON.parse(execution.input_json);}catch{continue;}
  if(!Array.isArray(ids)||ids.length!==1||ids[0]!==execution.message_id)continue;
  const input=all('messages').find(m=>m.chat_jid===group.jid&&m.id===ids[0]&&m.is_from_me===0&&typeof m.content==='string');
  if(input)answer.push({folder,sessionId:row.session_id,content:row.content,input:{id:input.id,content:input.content}});
 }
 return answer;
}
function settledSession(relative,raw,context,observedSessions,folder){
 const root=`sessions/${folder}/.claude/`;
 const rows=raw.trim().split('\n').map(line=>JSON.parse(line));if(rows.length<3||rows.length>64)return false;
 const header=rows.shift();
 if(!keys(header,['type','version','id','timestamp','cwd'])||header.type!=='session'||header.version!==3||header.cwd!=='/workspace/group'||!time(header.timestamp)||!/^[-a-f0-9]{36}$/.test(header.id??'')||
  header.timestamp!==new Date(header.timestamp).toISOString()||relative!==root+'sessions/'+header.timestamp.replace(/[:.]/g,'-')+'_'+header.id+'.jsonl'||observedSessions.has(header.id))return false;
 const result=context.filter(item=>item.folder===folder&&item.sessionId===header.id);if(result.length!==1)return false;
 const ids=new Set(),pending=new Set(),called=new Set();let previous=null,userCount=0,final=false,model=false,thinking=false;
 for(const entry of rows){
  if(final||!/^[a-f0-9]{8}$/.test(entry.id??'')||ids.has(entry.id)||entry.parentId!==previous||!time(entry.timestamp))return false;
  ids.add(entry.id);previous=entry.id;
  if(entry.type==='model_change'){
   if(model||userCount||!keys(entry,['type','id','parentId','timestamp','provider','modelId'])||entry.provider!=='anthropic'||typeof entry.modelId!=='string')return false;model=true;continue;
  }
  if(entry.type==='thinking_level_change'){
   if(thinking||userCount||!keys(entry,['type','id','parentId','timestamp','thinkingLevel'])||!['off','minimal','low','medium','high','xhigh'].includes(entry.thinkingLevel))return false;thinking=true;continue;
  }
  if(entry.type!=='message'||!keys(entry,['type','id','parentId','timestamp','message']))return false;
  const m=entry.message;if(!m||!Number.isFinite(m.timestamp))return false;
  if(m.role==='user'){
   if(++userCount!==1||pending.size||!keys(m,['role','content','timestamp'])||!textParts(m.content))return false;
   const inputs=[...m.content.map(p=>p.text).join('').matchAll(/<message id="([^"]+)"[^>]*>([\s\S]*?)<\/message>/g)];
   if(!result[0].input||inputs.length!==1||inputs[0][1]!==escapeXml(result[0].input.id)||inputs[0][2]!==escapeXml(result[0].input.content))return false;
  }else if(m.role==='assistant'){
   if(userCount!==1||!keys(m,['role','content','api','provider','model','usage','stopReason','timestamp']))return false;
   if(m.stopReason==='toolUse'){
    if(pending.size||!Array.isArray(m.content)||!m.content.length)return false;
    for(const c of m.content){
     if(!keys(c,['type','id','name','arguments'])||c.type!=='toolCall'||typeof c.id!=='string'||called.has(c.id)||c.name!=='read'||!keys(c.arguments,['path'])||
      !['approved.txt',...skills.map(id=>'/home/node/.claude/skills/'+id+'/SKILL.md'),'/workspace/project/private.txt','/workspace/other-user/private.txt'].includes(c.arguments.path))return false;
     called.add(c.id);pending.add(c.id);
    }
   }else{
    if(m.stopReason!=='stop'||pending.size||!called.size||!textParts(m.content)||m.content.map(p=>p.text).join('')!==result[0].content)return false;final=true;
   }
  }else if(m.role==='toolResult'){
   if(!keys(m,['role','toolCallId','toolName','content','isError','timestamp','details'])||!pending.has(m.toolCallId)||m.toolName!=='read'||typeof m.isError!=='boolean'||!textParts(m.content)||m.details!==undefined&&!exact(m.details,{}))return false;
   pending.delete(m.toolCallId);
  }else return false;
 }
 if(!final||pending.size!==0)return false;
 observedSessions.add(header.id);return true;
}
export function classifyLocalRunnerFile(relative,raw,context,observedSessions=new Set()){
 const folder=contextFolder(context),root=`sessions/${folder}/.claude/`;
 if(!folder||!knownFile(relative,folder)||typeof raw!=='string'||Buffer.byteLength(raw)>131072)return undefined;
 try{
  if(relative===`env/${folder}/default/main/env`){
   if(raw==="MINICLAW_CLAUDE_ENDPOINT_KIND='official'\n")return 'fixed_official_endpoint_env';
   if(raw==="MINICLAW_CLAUDE_ENDPOINT_KIND='official'\nMINICLAW_AGENT_MCP_POLICY='disabled'\n")return 'fixed_official_endpoint_disabled_mcp_env';
   return undefined;
  }
  if(relative.startsWith(root+'sessions/')&&/^\d{4}-\d\d-\d\dT[\d-Z]+_[-a-f0-9]{36}\.jsonl$/.test(relative.slice((root+'sessions/').length))){
   // No original Pi 0.84.2 session sample is available. The gate stays closed,
   // so only the already witnessed synthetic exact-D5 shape can be accepted.
   if(admitPiSessionBeyondSyntheticProtocol().admitted)return undefined;
   return settledSession(relative,raw,context,observedSessions,folder)?'settled_pi_session_exact_d5':undefined;
  }
  const value=JSON.parse(raw);
  if(relative==='config/container-claude-json.json')return exact(value,{hasCompletedOnboarding:true,autoUpdates:false})?'fixed_original_onboarding_config':undefined;
  if(['.miniclaw-native-settings.json','agent/auth.json','agent/models-store.json'].some(p=>relative===root+p))return exact(value,{})?'empty_original_runtime_store':undefined;
  if(relative===root+'agent/settings.json')return keys(value,['compaction'])&&exact(value.compaction,{enabled:true})?'fixed_pi_compaction_setting':undefined;
  if(relative===root+'settings.json'){
   const env={CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS:'0',CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD:'0',CLAUDE_CODE_DISABLE_AUTO_MEMORY:'1',CLAUDE_CODE_DISABLE_ATTACHMENTS:'1'};
   return keys(value,['env','mcpServers'])&&exact(value.env,env)&&exact(value.mcpServers,{})?'fixed_original_disabled_external_context':undefined;
  }
 }catch{}
 return undefined;
}
export function classifyLocalRunnerLink(relative,target,context){
 const folder=contextFolder(context);if(!folder)return undefined;
 const root=`sessions/${folder}/.claude/`;
 return skills.some(id=>relative===root+'skills/'+id&&target==='/workspace/effective-skills/'+id)?'original_rebuilt_skill_link':undefined;
}
/** Called only from the original descriptor walker with its already lstat'ed
 * entry. Never follows skill links. File bytes are bounded and tied to the
 * exact descriptor identity before and after reading. */
export function inspectLocalRunnerResidue(name,relative,stat,context,observedSessions){
 const stamp=s=>[s.dev,s.ino,s.mode,s.nlink,s.size,s.mtimeNs,s.ctimeNs].map(String).join(':');
 const folder=contextFolder(context);if(!folder)return undefined;
 if(stat.isSymbolicLink()){
  if(stat.uid!==0n||stat.gid!==0n)return undefined;
  const reason=classifyLocalRunnerLink(relative,fs.readlinkSync(name),context);
  return reason&&stamp(fs.lstatSync(name,{bigint:true}))===stamp(stat)?reason:undefined;
 }
 if(!knownFile(relative,folder)||!stat.isFile()||stat.uid!==1000n||stat.gid!==1000n||stat.nlink!==1n||stat.size>131072n||stat.size<0n||(stat.mode&0o022n)!==0n)return undefined;
 let fd;
 try{
  fd=fs.openSync(name,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW);
  if(stamp(fs.fstatSync(fd,{bigint:true}))!==stamp(stat))return undefined;
  const raw=fs.readFileSync(fd);if(raw.length!==Number(stat.size)||stamp(fs.fstatSync(fd,{bigint:true}))!==stamp(stat))return undefined;
  const reason=classifyLocalRunnerFile(relative,raw.toString('utf8'),context,observedSessions);
  return reason?reason+':'+createHash('sha256').update(raw).digest('hex'):undefined;
 }finally{if(fd!==undefined)fs.closeSync(fd);}
}
