import fs from 'node:fs';
import path from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';

export const existingStateBudgetMs=15*60*1000;
const primaryDatabase='state/runtime/data/db/messages.db';
const requiredAccessFiles=['frontagent-workbench-access.sqlite','frontagent-wecom-bindings.json','frontagent-approved-roles.json'];
const persistentDirectories=['drafts','manager','shadow','training','training-runs','training-sessions','training-pi','training-request-ledger-20261015','workbook-runner'];
type Entry={path:string;sha256:string;size:number};
interface Descriptor {
 format:'frontagent-existing-state-v1';accountId:string;homeJid:string;role:'marketing';profileId:string;workspaceJid:string;folder:string;
 tenantId:string;storeId:string;instanceId:string;employee:{employeeId:string;employeeName:string};adminCookie:string;
 expectedCounts:{users:number;profiles:number;groups:number};files:Entry[];
}
function requireState(condition:unknown,code:string):asserts condition {if(!condition)throw Error('FRONTAGENT_EXISTING_'+code);}
function inside(parent:string,child:string){const r=path.relative(parent,child);return r===''||(!path.isAbsolute(r)&&r!=='..'&&!r.startsWith('..'+path.sep));}
function noLinks(file:string){
 const absolute=path.resolve(file),root=path.parse(absolute).root;let current=root;
 for(const part of path.relative(root,absolute).split(path.sep).filter(Boolean)){
  current=path.join(current,part);let stat:fs.Stats;
  try{stat=fs.lstatSync(current);}catch{throw Error('FRONTAGENT_EXISTING_INPUT_MISSING');}
  requireState(!stat.isSymbolicLink(),'LINK_REFUSED');
  requireState(current===absolute||stat.isDirectory(),'PATH_ANCESTOR_INVALID');
 }
}
const digest=(value:Uint8Array|string)=>createHash('sha256').update(value).digest('hex');
function fileHash(file:string){noLinks(file);const stat=fs.lstatSync(file);requireState(stat.isFile()&&stat.nlink===1,'FILE_LINK_REFUSED');return digest(fs.readFileSync(file));}

/** Restrict permissions on task-owned Linux copies, retaining file bytes. */
function restrictExistingPilotConfigFile(hostRoot:string,name:'session-secret.key'|'system-settings.json'){
 requireState(path.isAbsolute(hostRoot),'ABSOLUTE_ROOT_REQUIRED');noLinks(hostRoot);
 const file=path.join(fs.realpathSync(hostRoot),'data/config',name);noLinks(file);
 const fd=fs.openSync(file,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW);
 try{
  const before=fs.fstatSync(fd);requireState(before.isFile()&&before.nlink===1&&(process.platform!=='linux'||before.uid===process.getuid?.()),'FILE_LINK_REFUSED');
  fs.fchmodSync(fd,0o600);const after=fs.fstatSync(fd);
  requireState(after.dev===before.dev&&after.ino===before.ino&&after.size===before.size&&(after.mode&0o777)===0o600,'FILE_MODE_INVALID');
  return {beforeMode:(before.mode&0o777).toString(8),afterMode:'600',changed:(before.mode&0o777)!==0o600};
 }finally{fs.closeSync(fd);}
}
export function restrictExistingPilotSessionKey(hostRoot:string){return restrictExistingPilotConfigFile(hostRoot,'session-secret.key');}
export function restrictExistingPilotSettings(hostRoot:string){return restrictExistingPilotConfigFile(hostRoot,'system-settings.json');}

/** Change only the stopped, task-owned host copy before the original main starts. */
export function disableExistingPilotPluginScan(hostRoot:string){
 requireState(path.isAbsolute(hostRoot),'ABSOLUTE_ROOT_REQUIRED');noLinks(hostRoot);
 const root=fs.realpathSync(hostRoot),file=path.join(root,'data/config/system-settings.json');
 noLinks(file);const stat=fs.lstatSync(file);requireState(stat.isFile()&&stat.nlink===1,'FILE_LINK_REFUSED');
 const original=fs.readFileSync(file),source=original.toString('utf8');let settings:unknown;
 requireState(Buffer.from(source,'utf8').equals(original),'SETTINGS_INVALID');
 try{settings=JSON.parse(source);}catch{throw Error('FRONTAGENT_EXISTING_SETTINGS_INVALID');}
 requireState(!!settings&&typeof settings==='object'&&!Array.isArray(settings)&&typeof (settings as Record<string,unknown>).pluginAutoScan==='boolean','SETTINGS_INVALID');
 const positions:number[]=[];let depth=0;
 for(let i=0;i<source.length;i++){
  const char=source[i];if(char==='{'||char==='['){depth++;continue;}if(char==='}'||char===']'){depth--;continue;}
  if(char!=='"')continue;const start=i++;for(;i<source.length;i++){if(source[i]==='\\'){i++;continue;}if(source[i]==='"')break;}
  if(depth!==1||JSON.parse(source.slice(start,i+1))!=='pluginAutoScan')continue;
  let next=i+1;while(/\s/.test(source[next]??'')&&next<source.length)next++;
  if(source[next]!==':')continue;next++;while(/\s/.test(source[next]??'')&&next<source.length)next++;positions.push(next);
 }
 requireState(positions.length===1,'SETTINGS_INVALID');
 const index=positions[0]!;requireState(source.startsWith((settings as Record<string,unknown>).pluginAutoScan?'true':'false',index),'SETTINGS_INVALID');
 if(!(settings as Record<string,unknown>).pluginAutoScan)return {beforeSha256:digest(original),afterSha256:digest(original),changed:false};
 const bytes=Buffer.from(source.slice(0,index)+'false'+source.slice(index+4));
 const temporary=file+'.pilot-'+randomUUID()+'.tmp';
 try{fs.writeFileSync(temporary,bytes,{flag:'wx',mode:stat.mode&0o777});fs.chmodSync(temporary,stat.mode&0o777);fs.renameSync(temporary,file);}finally{if(fs.existsSync(temporary))fs.unlinkSync(temporary);}
 return {beforeSha256:digest(original),afterSha256:digest(bytes),changed:true};
}
type SealFile={sha256:string;size:number};
function loadExistingSeal(inputRoot:string){
 const manifest=path.join(path.dirname(inputRoot),'frontagent-existing-input.manifest.json');
 if(!fs.existsSync(manifest))return undefined;
 let parsed:unknown;try{parsed=JSON.parse(fs.readFileSync(manifest,'utf8'));}catch{throw Error('FRONTAGENT_EXISTING_SEAL_INVALID');}
 const files=(parsed as {format?:string;files?:Record<string,SealFile>}).files;
 if((parsed as {format?:string}).format!=='qiwe-existing-input-v1'||!files||typeof files!=='object')throw Error('FRONTAGENT_EXISTING_SEAL_INVALID');
 return new Map(Object.entries(files));
}
function inventory(root:string,seal:Map<string,SealFile>|undefined,progress?:(event:{phase:'inventory'|'copy';count:number})=>void){
 const entries:Entry[]=[],directories:string[]=[];let count=0;
 function visit(relative:string){
  const absolute=path.join(root,relative);noLinks(absolute);const stat=fs.lstatSync(absolute);
  if(stat.isDirectory()){directories.push(relative);for(const name of fs.readdirSync(absolute).sort())visit(relative?relative+'/'+name:name);return;}
  if(stat.isFIFO()||stat.isSocket()||!stat.isFile())requireState(false,'FILE_TYPE_REFUSED');
  requireState(stat.nlink===1,'FILE_LINK_REFUSED');
  const known=seal?.get(relative);
  const sha256=known?known.sha256:fileHash(absolute);
  if(known&&(known.size!==stat.size||!/^[a-f0-9]{64}$/.test(known.sha256)))requireState(false,'SEAL_SIZE_MISMATCH');
  if(seal&&!known)requireState(false,'SEAL_FILE_UNEXPECTED');
  entries.push({path:relative,sha256,size:stat.size});count++;progress?.({phase:'inventory',count});
 }
 visit('state');visit('code');
 if(seal&&seal.size!==entries.length)requireState(false,'SEAL_FILE_MISMATCH');
 return {entries:entries.sort((a,b)=>a.path<b.path?-1:a.path>b.path?1:0),directories};
}
function descriptor(bytes:Buffer):Descriptor {
 let value:unknown;try{value=JSON.parse(bytes.toString('utf8'));}catch{throw Error('FRONTAGENT_EXISTING_DESCRIPTOR_INVALID');}
 requireState(!!value&&typeof value==='object'&&!Array.isArray(value),'DESCRIPTOR_INVALID');
 const d=value as Descriptor,id=(s:unknown)=>typeof s==='string'&&s.length>0&&s.length<=200&&!/[\s\u0000\r\n]/.test(s);
 requireState(d.format==='frontagent-existing-state-v1'&&d.role==='marketing','DESCRIPTOR_FORMAT');
 requireState([d.accountId,d.homeJid,d.profileId,d.workspaceJid,d.tenantId,d.storeId,d.instanceId].every(id)&&d.homeJid!==d.workspaceJid&&d.homeJid.startsWith('web:')&&d.workspaceJid.startsWith('web:'),'IDENTITY_INVALID');
 requireState(id(d.folder)&&!/[\\/]/.test(d.folder)&&d.folder!=='.'&&d.folder!=='..','PATH_FOLDER_INVALID');
 requireState(d.employee&&id(d.employee.employeeId)&&typeof d.employee.employeeName==='string'&&d.employee.employeeName.length>0&&d.employee.employeeName.length<=200,'IDENTITY_EMPLOYEE_INVALID');
 requireState(typeof d.adminCookie==='string'&&d.adminCookie.startsWith('miniclaw_session=')&&d.adminCookie.length>17&&d.adminCookie.length<=4096&&!/[\r\n\u0000]/.test(d.adminCookie),'DESCRIPTOR_SESSION_INVALID');
 requireState(d.expectedCounts?.users===2&&d.expectedCounts.profiles===16&&d.expectedCounts.groups===16,'COUNT_EXPECTATION_INVALID');
 requireState(Array.isArray(d.files)&&d.files.length>0,'FILE_INVENTORY_INVALID');
 const seen=new Set<string>();
 for(const entry of d.files){
  requireState(entry&&typeof entry.path==='string'&&/^(?:state|code)\//.test(entry.path)&&!entry.path.includes('\\')&&!entry.path.includes('\u0000')&&!entry.path.split('/').some(part=>part===''||part==='.'||part==='..')&&!path.posix.isAbsolute(entry.path)&&!path.win32.isAbsolute(entry.path),'FILE_PATH_INVALID');
  requireState(!seen.has(entry.path)&&typeof entry.sha256==='string'&&/^[a-f0-9]{64}$/.test(entry.sha256),'FILE_INVENTORY_INVALID');seen.add(entry.path);
 }
 return d;
}

/** Explicit opt-in only. Never reinterpret an invalid existing-state request as a synthetic seed. */
export function parseExistingFrontagentStateOption(args:readonly string[],platform:NodeJS.Platform=process.platform):{args:string[];inputRoot?:string}{
 const indexes=args.flatMap((v,i)=>v==='--frontagent-existing-state'?[i]:[]);
 if(!indexes.length)return {args:[...args]};
 requireState(indexes.length===1,'OPTION_DUPLICATE');const index=indexes[0]!,inputRoot=args[index+1];
 requireState(typeof inputRoot==='string'&&path.isAbsolute(inputRoot)&&!inputRoot.startsWith('--'),'ABSOLUTE_INPUT_REQUIRED');
 requireState(platform==='linux'&&['--restoration-real-container','--restoration-scenario','--full-host-conversations'].every(flag=>args.includes(flag))&&!args.includes('--restoration-pi-scenario')&&!args.includes('--c4-synthetic-case'),'MODE_REQUIRES_REAL_LINUX_RESTORATION');
 return {args:args.filter((_,i)=>i!==index&&i!==index+1),inputRoot};
}

/** Materialize a stopped operator-owned R1 snapshot into the existing full-host root.
 * Only runtime/data is remapped. No Native initializer, provisioning, role installation,
 * grant writer, binding writer, alternate database, or account creation runs here.
 * Runtime readers remain responsible for authorizing the descriptor's requested identity.
 */
function copyExclusive(source:string,target:string,size:number,tick?:()=>void){
 if(size<=1024*1024){fs.copyFileSync(source,target,fs.constants.COPYFILE_EXCL);tick?.();return;}
 const input=fs.openSync(source,fs.constants.O_RDONLY|(fs.constants.O_NOFOLLOW??0));
 const output=fs.openSync(target,fs.constants.O_WRONLY|fs.constants.O_CREAT|fs.constants.O_EXCL,0o644);
 const buffer=Buffer.alloc(1024*1024);
 try{
  let offset=0;
  while(offset<size){
   const read=fs.readSync(input,buffer,0,buffer.length,offset);
   if(read<=0)break;
   let written=0;while(written<read)written+=fs.writeSync(output,buffer,written,read-written);
   offset+=read;tick?.();
  }
  requireState(offset===size,'FILE_COPY_SIZE_MISMATCH');
 }finally{fs.closeSync(input);fs.closeSync(output);}
}
export function prepareExistingFrontagentState(options:{inputRoot:string;hostRoot:string;budgetMs?:number;now?:()=>number;progress?:(event:{phase:'inventory'|'copy';count:number})=>void}){
 requireState(path.isAbsolute(options.inputRoot)&&path.isAbsolute(options.hostRoot),'ABSOLUTE_ROOT_REQUIRED');
 noLinks(options.inputRoot);noLinks(options.hostRoot);
 const inputRoot=fs.realpathSync(options.inputRoot),hostRoot=fs.realpathSync(options.hostRoot);
 requireState(!inside(inputRoot,hostRoot)&&!inside(hostRoot,inputRoot),'ROOT_OVERLAP');
 requireState(fs.lstatSync(inputRoot).isDirectory()&&fs.lstatSync(hostRoot).isDirectory(),'ROOT_INVALID');
 requireState(fs.readdirSync(inputRoot).sort().join('\0')===['code','descriptor.json','state'].join('\0'),'INPUT_FILE_SET_INVALID');
 const descriptorFile=path.join(inputRoot,'descriptor.json');fileHash(descriptorFile);
 const seal=loadExistingSeal(inputRoot);
 const clock=options.now??Date.now,started=clock();
 const note=(event:{phase:'inventory'|'copy';count:number})=>{
  if(options.budgetMs!=null&&clock()-started>options.budgetMs){const error=Error('FULL_HOST_STEP_TIMEOUT') as Error&{step:string};error.step='existing-state';throw error;}
  options.progress?.(event);
 };
 const descriptorBytes=fs.readFileSync(descriptorFile),d=descriptor(descriptorBytes),before=inventory(inputRoot,seal,note);
 requireState(before.entries.length===d.files.length&&before.entries.every(entry=>d.files.some(f=>f.path===entry.path&&f.sha256===entry.sha256)),'FILE_HASH_INVENTORY_MISMATCH');
 const names=new Set(before.entries.map(e=>e.path));requireState(names.has(primaryDatabase)&&fs.statSync(path.join(inputRoot,primaryDatabase)).size>0,'DATABASE_MISSING');
 for(const name of requiredAccessFiles)requireState(names.has('state/runtime/data/'+name),'ACCESS_FILE_MISSING');
 requireState(names.has('state/runtime/data/config/session-secret.key')&&fs.statSync(path.join(inputRoot,'state/runtime/data/config/session-secret.key')).size>0,'SESSION_FILE_MISSING');
 requireState(['code/product-web.mjs','code/product-modules.mjs','code/product-web.d.mts','code/product-modules.d.mts','code/web/dist/index.html'].every(name=>names.has(name))&&before.entries.some(e=>e.path.startsWith('code/product/')),'CODE_FILE_MISSING');
 const mapped=(name:string):string|undefined=>{
  if(name==='state'||name==='code'||name==='state/runtime/data')return name==='state/runtime/data'?'data':undefined;
  if(name.startsWith('state/runtime/data/'))return name.slice('state/runtime/'.length);
  if(name.startsWith('state/')){
   const relative=name.slice('state/'.length),top=relative.split('/')[0]!;
   requireState(persistentDirectories.includes(top)||relative==='runtime'||relative==='runtime/groups'||relative.startsWith('runtime/groups/'),'STATE_PATH_INVALID');return relative;
  }
  if(name==='code/product'||name.startsWith('code/product/')||['code/product-web.mjs','code/product-modules.mjs','code/product-web.d.mts','code/product-modules.d.mts'].includes(name))return 'frontagent-product/'+name.slice('code/'.length);
  if(name==='code/web'||name.startsWith('code/web/'))return name.slice('code/'.length);
  return undefined;
 };
 // Validate the complete destination set before writing anything; an existing candidate file is never merged.
 const destinations=[...before.directories,...before.entries.map(e=>e.path)].map(name=>({name,target:mapped(name)})).filter((e):e is {name:string;target:string}=>e.target!==undefined);
 requireState(!fs.existsSync(path.join(hostRoot,'frontagent-product'))&&destinations.every(e=>inside(hostRoot,path.join(hostRoot,e.target))&&!fs.existsSync(path.join(hostRoot,e.target))),'TARGET_ALREADY_EXISTS');
 for(const entry of destinations.filter(e=>before.directories.includes(e.name)))fs.mkdirSync(path.join(hostRoot,entry.target),{recursive:true});
 let copied=0;
 for(const entry of destinations.filter(e=>names.has(e.name))){
  const recorded=before.entries.find(e=>e.path===entry.name)!;
  const source=path.join(inputRoot,entry.name),target=path.join(hostRoot,entry.target);fs.mkdirSync(path.dirname(target),{recursive:true});
  copyExclusive(source,target,recorded.size,()=>note({phase:'copy',count:copied+1}));
  if(seal)requireState(fs.statSync(target).size===recorded.size,'FILE_COPY_SIZE_MISMATCH');
  else requireState(fileHash(target)===recorded.sha256,'FILE_COPY_HASH_MISMATCH');
  copied++;
 }
 let ownerId:string,counts:{users:number;profiles:number;groups:number};
 const db=new DatabaseSync(path.join(hostRoot,'data/db/messages.db'),{readOnly:true});
 try{
  db.exec('PRAGMA query_only=ON; BEGIN');
  requireState(db.prepare('PRAGMA quick_check').get()?.quick_check==='ok','DATABASE_INVALID');
  const count=(table:string)=>Number(db.prepare('SELECT COUNT(*) AS n FROM '+table).get()?.n);
  counts={users:count('users'),profiles:count('agent_profiles'),groups:count('registered_groups')};
  requireState(Object.entries(counts).every(([name,n])=>n===d.expectedCounts[name as keyof typeof counts]),'COUNT_MISMATCH');
  const admins=db.prepare("SELECT id FROM users WHERE role='admin' AND status='active'").all();
  requireState(admins.length===1&&typeof admins[0]?.id==='string'&&admins[0].id!==d.accountId,'ADMIN_AMBIGUOUS');ownerId=admins[0].id;
  const user=db.prepare('SELECT id,role,status,must_change_password FROM users WHERE id=?').get(d.accountId);
  requireState(user?.id===d.accountId&&user.role==='member'&&user.status==='active'&&user.must_change_password===0,'IDENTITY_INACTIVE');
  const homes=db.prepare('SELECT jid,execution_mode FROM registered_groups WHERE created_by=? AND is_home=1').all(d.accountId);
  requireState(homes.length===1&&homes[0]?.jid===d.homeJid&&homes[0].execution_mode==='container','HOME_MAPPING_INVALID');
  const group=db.prepare('SELECT folder,created_by,is_home,execution_mode FROM registered_groups WHERE jid=?').get(d.workspaceJid);
  const profile=db.prepare('SELECT owner_user_id,status FROM agent_profiles WHERE id=?').get(d.profileId);
  const links=db.prepare('SELECT agent_profile_id FROM workspace_agent_profiles WHERE group_folder=?').all(d.folder);
  requireState(group?.folder===d.folder&&group.created_by===d.accountId&&group.is_home===0&&group.execution_mode==='container'&&profile?.owner_user_id===d.accountId&&profile.status==='active'&&links.length===1&&links[0]?.agent_profile_id===d.profileId,'IDENTITY_RESOURCE_MAPPING_INVALID');
  db.exec('COMMIT');
 }catch{throw Error('FRONTAGENT_EXISTING_IDENTITY_DATABASE_MAPPING_INVALID');}finally{db.close();}
 requireState(digest(fs.readFileSync(descriptorFile))===digest(descriptorBytes)&&digest(JSON.stringify(inventory(inputRoot,seal,note).entries))===digest(JSON.stringify(before.entries)),'INPUT_CHANGED_DURING_COPY');
 return {codeRoot:path.join(hostRoot,'frontagent-product'),jobRoot:hostRoot,ownerId,containerPrefix:'miniclaw-'+d.folder+'-',audit:{format:1,descriptorSha256:digest(descriptorBytes),inputSha256:digest(JSON.stringify(before.entries)),files:before.entries.length,counts}};
}
