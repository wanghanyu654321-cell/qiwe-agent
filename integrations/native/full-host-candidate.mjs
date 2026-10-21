import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {fileURLToPath,pathToFileURL} from 'node:url';
import ts from 'typescript';
import {createHostCandidate,hostNativeHashes,hostOverlayHashes} from './host-candidate.mjs';
import {transformNative} from './targeted-execution.mjs';
import {applyRecoveryInspectionOverlay} from './recovery-inspection-overlay.mjs';
import {applyProjectResidueOverlay} from './project-residue-overlay.mjs';
import {applyQueueRecoveryOverlay} from './queue-recovery-overlay.mjs';
import {extractOwnedWorkspaceService,extractOwnedProfileService,addOwnedWorkspaceClaims} from './role-workspace-overlay.mjs';

const digest=value=>createHash('sha256').update(value).digest('hex');
export const fullHostSourceIdentity='8611519397c78b1f5d9591ae18ea2c5d1c399aab3d63b9ea5311ebd8c18b0bad';
export const fullHostOverlayIdentity='054aff69be686477c6df8acf8f84810d43aba538a3643fcca2a2f32d1f5e11e0';
function tree(root,filter){
 const files=new Map();
 function walk(relative=''){for(const entry of fs.readdirSync(path.join(root,relative),{withFileTypes:true})){
  const name=path.posix.join(relative,entry.name);
  if(entry.isDirectory())walk(name);else if(filter(name))files.set(name,fs.readFileSync(path.join(root,name)));
 }}walk();return new Map([...files].sort(([a],[b])=>a.localeCompare(b,'en')));
}
export function sourceTreeIdentity(files){return digest([...files].map(([name,bytes])=>name+'\0'+digest(bytes)).join('\n'));}
function replaceOnce(source,before,after){if(source.split(before).length!==2)throw Error('FULL_HOST_ANCHOR_CHANGED');return source.replace(before,after);}
function declaration(source,name){const parsed=ts.createSourceFile('db.ts',source,ts.ScriptTarget.Latest,true);const nodes=parsed.statements.filter(node=>ts.isFunctionDeclaration(node)&&node.name?.text===name);if(nodes.length!==1)throw Error('FULL_HOST_DECLARATION_CHANGED: '+name);return source.slice(nodes[0].getStart(parsed),nodes[0].end);}

/** Build strings only; never evaluate original config/index/DB, or write N/O. */
export async function createFullHostCandidate(nativeRoot,overlayRoot){
 const native=tree(nativeRoot,name=>name.endsWith('.ts')&&!/\.(test|spec)\.ts$/.test(name));
 const overlay=tree(overlayRoot,name=>/\.(ts|mjs|fragment)$/.test(name)&&!name.endsWith('.d.mts'));
 if(sourceTreeIdentity(native)!==fullHostSourceIdentity)throw Error('FULL_HOST_NATIVE_TREE_CHANGED');
 if(sourceTreeIdentity(overlay)!==fullHostOverlayIdentity)throw Error('FULL_HOST_OVERLAY_TREE_CHANGED');
 const focused=await createHostCandidate(nativeRoot,overlayRoot);
 const privateRoot=path.resolve(overlayRoot).replaceAll('\\','/')+'/';
 const moduleUrls=new Map();
 function snapshot(name){
  if(moduleUrls.has(name))return moduleUrls.get(name);
  let code=overlay.get(name)?.toString('utf8');if(code===undefined)throw Error('FULL_HOST_HELPER_MISSING: '+name);
  code=code.replace(/from '(\.\/[^']+\.mjs)'/g,(_all,relative)=>`from '${snapshot(relative.slice(2))}'`);
  code=code.replace("import ts from 'typescript';",`import ts from '${import.meta.resolve('typescript')}';`);
  code=code.replace(/readFileSync\(\s*new URL\('\.\/([^']+\.fragment)', import\.meta\.url\),\s*'utf8',?\s*\)/g,(_all,fragment)=>JSON.stringify(overlay.get(fragment).toString('utf8')));
  code=code.replaceAll('import.meta.url',JSON.stringify(pathToFileURL(path.join(overlayRoot,name)).href));
  const url='data:text/javascript;base64,'+Buffer.from(code).toString('base64');moduleUrls.set(name,url);return url;
 }
 const inventory=await import(snapshot('appointment-boot-inventory-overlay.mjs'));
 const files=new Map();
 for(const [name,bytes]of native){
  let value=inventory.applyBootInventoryCandidate(bytes.toString('utf8'),path.join(nativeRoot,name));
  // Preserve O's complete DB boot/rejection/inventory stack and transplant only
  // T7's independently validated exact claim function (all other DB code stays).
  if(name==='db.ts'){
   const original=bytes.toString('utf8').replaceAll('\r\n','\n'),target=transformNative(name,bytes);
   value=replaceOnce(value,declaration(original,'claimNextTaskRun'),['claimNextTaskRun','claimTaskRunById','claimTaskRun'].map(fn=>declaration(target,fn)).join('\n\n'));
  }
  if(name==='task-scheduler.ts')value=focused.files.get(name);
  files.set(name,value);
 }
 // Copy only the runtime closure referenced by the transformed host stack.
 const pending=[...files.values()].flatMap(value=>[...value.matchAll(/(?:from|import)\s*['"]([^'"]+)['"]/g)].map(match=>match[1])).filter(spec=>spec.startsWith(privateRoot));
 const included=new Set();
 while(pending.length){
  const spec=pending.pop(),name=spec.slice(privateRoot.length).replace(/\.js$/,'.ts');
  if(included.has(name))continue;included.add(name);
  const bytes=overlay.get(name);if(!bytes)throw Error('FULL_HOST_RUNTIME_MISSING: '+name);
  const value=bytes.toString('utf8');files.set(name,value);
  for(const match of value.matchAll(/(?:from|import)\s*['"]([^'"]+)['"]/g))if(match[1].startsWith('./')&&match[1].endsWith('.js'))pending.push(privateRoot+match[1].slice(2));
 }
 for(const [name,value]of files){
  const directory=path.posix.dirname(name);
  const rewritten=value.replace(/((?:from\s*|import\(\s*)['"])([^'"]+)(['"])/g,(whole,prefix,spec,quote)=>{
   let target;
   if(spec.startsWith(privateRoot))target=spec.slice(privateRoot.length);
   else if(spec.startsWith('../../../full-instance/stage/app/src/'))target=spec.slice('../../../full-instance/stage/app/src/'.length);
   if(target===undefined)return whole;
   let relative=path.posix.relative(directory,target);if(!relative.startsWith('.'))relative='./'+relative;return prefix+relative+quote;
  });
  if(rewritten.includes(privateRoot)||rewritten.includes('../../../full-instance/stage/app/src/'))throw Error('FULL_HOST_PRIVATE_IMPORT_REMAINS: '+name+' '+rewritten.slice(rewritten.indexOf(privateRoot)-80,rewritten.indexOf(privateRoot)+180));
  files.set(name,rewritten);
 }
 const adapted=applyRecoveryInspectionOverlay(files);
 adapted.set('group-queue.ts',applyQueueRecoveryOverlay(adapted.get('group-queue.ts')));
 adapted.set('appointment-boot-inventory.ts',applyProjectResidueOverlay(adapted.get('appointment-boot-inventory.ts')));
 adapted.set('recovery-inspection.ts',fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)),'recovery-inspection.ts'),'utf8'));
 adapted.set('routes/groups.ts',extractOwnedWorkspaceService(adapted.get('routes/groups.ts')));
 adapted.set('routes/agent-profiles.ts',extractOwnedProfileService(adapted.get('routes/agent-profiles.ts')));
 adapted.set('db.ts',addOwnedWorkspaceClaims(adapted.get('db.ts')));
 return {files:adapted,audit:{nativeTree:fullHostSourceIdentity,overlayTree:fullHostOverlayIdentity,nativeHashes:hostNativeHashes,overlayHashes:hostOverlayHashes,runtimeOverlayFiles:[...included].sort(),composedHashes:Object.fromEntries([...adapted].map(([name,value])=>[name,digest(value)])),recoveryInspection:'current-admin read-only diagnostics; no restore permit',projectConfigurationCoverage:'original descriptor scanner extended to project .env/config; all original blockers retained',scope:'actual original index main, complete O host/queue/Web/DB stack plus exact T7 DB/scheduler and recovery inspection; no inventory completion bypass'}};
}
