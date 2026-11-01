import fs from 'node:fs';
import {createHash} from 'node:crypto';
import ts from 'typescript';
import {assertFullHostWriterCoverage} from './full-host-entry-fencing-overlay.mjs';
const digest=value=>createHash('sha256').update(value).digest('hex');
function once(source,before,after){if(typeof source!=='string'||source.split(before).length!==2)throw Error('FULL_HOST_RESTORATION_ANCHOR_CHANGED:'+before.slice(0,80));return source.replace(before,after);}

/** Original scanner and original assembly are retained. The only additional
 * eligibility is derived from bounded actual rows, exact durable suppression,
 * source-verified current-writer fences and the physical local supervisor. */
export function applyFullHostRestoration(files,{supervisorSourceHash,supervisorModuleHash}={}){
 if(!/^[a-f0-9]{64}$/.test(supervisorSourceHash??'')||!/^[a-f0-9]{64}$/.test(supervisorModuleHash??''))throw Error('RESTORATION_SUPERVISOR_IDENTITY_REQUIRED');
 const coverage=assertFullHostWriterCoverage(files);
 if(!coverage||typeof coverage!=='object'||Array.isArray(coverage)||Object.keys(coverage).length===0)throw Error('RESTORATION_COVERAGE_UNAVAILABLE');
 const result=new Map(files);
 // This local recovery case retains an untouched producer event; it does not
 // acknowledge delivery. The original producer and complete source trees are
 // pinned, and no added runtime module may introduce another table consumer.
 const existingMemoryProducerOnly=digest(files.get('memory-store.ts')??'')==='e7b38008921c50b05626f7b5c39acbdca86fdc25b0fa825c5eb988e90edc831f'&&
  [...files].every(([name,code])=>!code.includes('workspace_memory_outbox')||['memory-store.ts','appointment-boot-inventory.ts','appointment-boot-inventory-schema.ts'].includes(name));
 result.set('full-host-restoration-context.ts',`import { DATA_DIR } from './config.js';
import { inspectRestorationBoundary } from './full-host-restoration-boundary.js';
export function verifyCurrentLocalBoundary(){
 return inspectRestorationBoundary(DATA_DIR,${JSON.stringify(supervisorSourceHash)},${JSON.stringify(supervisorModuleHash)});
}
`);
 const indexContracts=new Map();
 const normalizeIndex=sql=>sql.replace(/\s+IF\s+NOT\s+EXISTS\s+/i,' ').replace(/;\s*$/,'').replace(/\s+/g,' ').trim();
 for(const [name,code] of files){
  if(!name.endsWith('.ts'))continue;
  const parsed=ts.createSourceFile(name,code,ts.ScriptTarget.Latest,true);
  function visit(node){
   if(ts.isStringLiteral(node)||ts.isNoSubstitutionTemplateLiteral(node)){
    for(const match of node.text.matchAll(/CREATE\s+(?:UNIQUE\s+)?INDEX(?:\s+IF\s+NOT\s+EXISTS)?\s+(\w+)\s+ON\s+\w+\s*\([^;]*?(?:;|$)/g)){
     const statements=indexContracts.get(match[1])??new Set();statements.add(normalizeIndex(match[0]));indexContracts.set(match[1],statements);
    }
   }
   ts.forEachChild(node,visit);
  } visit(parsed);
 }
 if(indexContracts.size===0)throw Error('RESTORATION_INDEX_CONTRACT_MISSING');
 for(const name of ['full-host-restoration-classifier','full-host-restoration-boundary'])result.set(name+'.ts',fs.readFileSync(new URL('./'+name+'.ts',import.meta.url),'utf8'));
 const dockerHelper=fs.readFileSync(new URL('./full-host-local-docker.mjs',import.meta.url),'utf8');
 result.set('full-host-local-docker.mjs',dockerHelper);
 result.set('full-host-local-docker.d.mts',fs.readFileSync(new URL('./full-host-local-docker.d.mts',import.meta.url),'utf8'));
 for(const name of ['full-host-local-residue.mjs','full-host-local-residue.d.mts'])result.set(name,fs.readFileSync(new URL('./'+name,import.meta.url),'utf8'));
 for(const name of ['full-host-existing-config.mjs','full-host-existing-config.d.mts'])result.set(name,fs.readFileSync(new URL('./'+name,import.meta.url),'utf8'));
 for(const name of ['full-host-existing-profile.mjs','full-host-existing-profile.d.mts'])result.set(name,fs.readFileSync(new URL('./'+name,import.meta.url),'utf8'));
 result.set('full-host-restoration-boundary.ts',result.get('full-host-restoration-boundary.ts').replace('LOCAL_DOCKER_HELPER_HASH',digest(dockerHelper)));
 let source=files.get('appointment-boot-inventory.ts').replaceAll('\r\n','\n');
 source=`import { classifyRestorationRow, classifyRestorationResidue, isPassiveOriginalRunnerSnapshot, type RestorationRow } from './full-host-restoration-classifier.js';
import { inspectRestorationBoundary } from './full-host-restoration-boundary.js';
import { readLegacyWorkPreservationEvidence } from './legacy-work-preservation.js';
import { getSystemSettings } from './runtime-config.js';
import { WEB_SESSION_SECRET } from './config.js';
import { inspectExistingConfig } from './full-host-existing-config.mjs';
import { inspectExistingProfileContext } from './full-host-existing-profile.mjs';
import { BUSINESS_EXECUTION_BOUNDARY } from './business-execution-policy.js';
import { inspectLocalRunnerResidue, settledLocalSessions, type SettledLocalSession } from './full-host-local-residue.mjs';
`+source;
 source=once(source,"const digest = (value: string) =>",`const restorationIndexContracts: Record<string,readonly string[]> = ${JSON.stringify(Object.fromEntries([...indexContracts].map(([name,values])=>[name,[...values]])))};
const normalizeRestorationIndex=(sql:string)=>sql.replace(/\\s+IF\\s+NOT\\s+EXISTS\\s+/i,' ').replace(/;\\s*$/,'').replace(/\\s+/g,' ').trim();
const digest = (value: string) =>`);
 const masterTypes="type IN ('table','trigger','view')";
 if(source.split(masterTypes).length!==3)throw Error('RESTORATION_SCHEMA_MASTER_ANCHOR_CHANGED');
 source=source.replaceAll(masterTypes,"type IN ('table','trigger','view','index')");
 source=once(source,'            const expected =\n',`            if(object.type==='index') {
              const name=String(object.name);
              // SQLite creates these from the already exact table SQL; users
              // cannot CREATE objects in the reserved sqlite_ namespace.
              const automatic=object.sql===null&&name.startsWith('sqlite_autoindex_')&&
                appointmentInventorySchemas.some(table=>name.startsWith('sqlite_autoindex_'+table.name+'_'));
              if(!automatic&&(typeof object.sql!=='string'||!restorationIndexContracts[name]?.includes(normalizeRestorationIndex(object.sql))))
                blockers.add('SCHEMA:'+name);
              records.push({kind:'observation/sqlite_index',key:digest(name),version:digest(JSON.stringify([name,object.sql])),
                disposition:automatic||!blockers.has('SCHEMA:'+name)?'eligible':'blocked',evidence:['exact_source_index_contract']});
              continue;
            }
            const expected =
`);
 source=once(source,'  let rowsEstimated = 0,',`  const restorationRows = new Map<string, RestorationRow[]>();
  const restorationRecords: Array<{table:string;row:Row;record:Inventory['records'][number];index:number}> = [];
  let boundaryVersion: string | undefined;
  try {
    if (!dataDir) throw Error('missing_restoration_data_root');
    if (BUSINESS_EXECUTION_BOUNDARY !== 'member-container-only') throw Error('unsupported_execution_boundary');
    if (getSystemSettings().pluginAutoScan !== false) {
      blockers.add('UNSUPPORTED_PLUGIN_AUTOSCAN');
      throw Error('unsupported_plugin_autoscan');
    }
    const boundary=inspectRestorationBoundary(dataDir,${JSON.stringify(supervisorSourceHash)},${JSON.stringify(supervisorModuleHash)});
    boundaryVersion=boundary.version;
    records.push({kind:'observation/local_restoration_boundary',key:digest('local-supervisor'),version:boundary.version,
      disposition:'eligible',evidence:boundary.evidence});
    blockers.delete('EXTERNAL_WRITERS_UNVERIFIED');
    blockers.delete('WRITER_COVERAGE_INCOMPLETE');
    records.push({kind:'observation/current_writer_source_coverage',key:digest('supported-source-coverage'),
      version:${JSON.stringify(digest(JSON.stringify(coverage)))},disposition:'eligible',evidence:['supported_source_fences','original_gate_write_obligations']});
  } catch { blockers.add('LOCAL_SUPERVISOR_BOUNDARY_UNVERIFIED'); }
  let rowsEstimated = 0,`);
 source=once(source,'  remainingBytes: number,\n): void {','  remainingBytes: number,\n  registeredFolders: ReadonlySet<string>,\n  localSessions: readonly SettledLocalSession[],\n  existingConfiguration: boolean,\n): void {');
 source=once(source,"  function add(relative: string, kind: string, stamp: string, evidence: string) {",`  const observedLocalSessions=new Set<string>();
  function add(relative: string, kind: string, stamp: string, evidence: string) {
    const passiveSnapshot=isPassiveOriginalRunnerSnapshot(relative,kind,registeredFolders);
    const migrationMarker=kind==='config/opaque'&&relative==='config/.im-config-migrated';`);
 source=once(source,"evidence: ['filesystem_metadata_only', evidence] });","evidence: ['filesystem_metadata_only', evidence, ...(passiveSnapshot?['passive_original_runner_snapshot']:[]), ...(migrationMarker?['original_im_migration_presence_marker']:[])] });");
 source=once(source,"            add(key, stat.isFile() ? fileKind(root, key) : root + '/unsafe', version(stat),\n              stat.isFile() ? 'file_unsettled' : 'unsafe_entry');\n            if (!stat.isFile()) blockers.add('RESIDUE:UNSAFE_ENTRY');",`            if(localSessions.length&&stat.isFile()&&stat.size<=131072n)remainingBytes-=Number(stat.size)*6;
            const existingConfig=existingConfiguration&&root==='config'&&['config/session-secret.key','config/system-settings.json'].includes(key);
            if(existingConfig&&!localSessions.length&&stat.isFile()&&stat.size<=131072n)remainingBytes-=Number(stat.size)*6;
            if(remainingBytes<0)blockers.add('RESIDUE:BUDGET');
            const verifiedLocal=localSessions.length&&remainingBytes>=0?inspectLocalRunnerResidue(name,key,stat,localSessions,observedLocalSessions):undefined;
            const verifiedConfig=existingConfig&&stat.isFile()&&remainingBytes>=0?inspectExistingConfig(fd,key,stat,{webSessionSecret:WEB_SESSION_SECRET,pluginAutoScan:getSystemSettings().pluginAutoScan}):undefined;
            add(key, stat.isFile() ? fileKind(root, key) : root + (verifiedLocal?'/passive_link':'/unsafe'), version(stat),
              verifiedConfig?'verified_existing_config:'+verifiedConfig:verifiedLocal?'verified_local_runner_residue:'+verifiedLocal:stat.isFile()?'file_unsettled':'unsafe_entry');
            if (!stat.isFile()&&!verifiedLocal) blockers.add('RESIDUE:UNSAFE_ENTRY');`);
 source=once(source,'    started + 5000, 100000 - rowsEstimated, 64 * 1024 * 1024 - estimatedBytes);',`    started + 5000, 100000 - rowsEstimated, 64 * 1024 * 1024 - estimatedBytes,
    new Set((restorationRows.get('registered_groups')??[]).map(row=>String(row.folder))),
    boundaryVersion&&process.env.QIWE_RESTORATION_REAL_CONTAINER==='1'?settledLocalSessions(restorationRows,restorationRecords,process.env.QIWE_FRONTAGENT_EXISTING_INPUT?(process.env.QIWE_FRONTAGENT_EXISTING_FOLDER??''):undefined):[],
    !!boundaryVersion&&!!process.env.QIWE_FRONTAGENT_EXISTING_INPUT);`);
 // Full row values remain private; hashes detect changes to opaque payloads.
 // Probe lengths and all existing budgets run before these values are read.
 source=once(source,`            columns = [
              ...new Set([...keys, ...metadataText.split(',').filter(Boolean)]),
            ];`,`            columns = [...new Set([...appointmentInventorySchemas.find(item=>item.name===table)!.columns.map(item=>item[0]), ...keys])];
          restorationRows.set(table,[]);`);
 // SQLite reports a selected _rowid_ expression as rowid unless aliased. Keep
 // the original paging key and every original type/null check intact.
 source=once(source,"'SELECT ' + columns.map(quoted).join(',') + ' FROM ' + source;", "'SELECT ' + columns.map(column=>quoted(column)+(column==='_rowid_'?' AS '+quoted(column):'')).join(',') + ' FROM ' + source;");
 source=once(source,'              cursor = row;',`              const record = records[records.length - 1]!;
              const observed=restorationRows.get(table)??[]; observed.push(row); restorationRows.set(table,observed);
              restorationRecords.push({table,row,record,index:records.length-1});
              cursor = row;`);
 source=once(source,'        }\n      })\n      .deferred();',`        }
        const existingLocal=!!boundaryVersion&&!!dataDir&&!!process.env.QIWE_FRONTAGENT_EXISTING_INPUT;
        const foldersByOwner=new Map<string,string[]>(),contextCache=new Map<string,boolean>();
        if(existingLocal)for(const group of restorationRows.get('registered_groups')??[]){if(!budget())return;if(typeof group.created_by==='string'){const folders=foldersByOwner.get(group.created_by)??[];folders.push(String(group.folder));foldersByOwner.set(group.created_by,folders);}}
        const contextBudget=()=>{if(++rowsEstimated>100000){blockers.add('BUDGET:ROWS');return false;}return budget();};
        const profileContext=(owner:unknown)=>{
          if(!existingLocal||typeof owner!=='string')return false;
          if(!contextCache.has(owner))contextCache.set(owner,inspectExistingProfileContext(dataDir!,owner,foldersByOwner.get(owner)??[],contextBudget));
          return contextCache.get(owner)===true;
        };
        const memoryProducerRetained=existingLocal&&${JSON.stringify(existingMemoryProducerOnly)}&&(restorationRows.get('users')??[]).every(user=>profileContext(user.id));
        for (const item of restorationRecords) {
          if(!budget())return;
          const {table,row,record}=item;
          let preserved;
          try { preserved=readLegacyWorkPreservationEvidence(connection,table,row,restorationRows); }
          catch { blockers.add('PRESERVATION:UNVERIFIED'); }
          const localEvidence=[...record.evidence,...(existingLocal&&table==='agent_profiles'&&profileContext(row.owner_user_id)?['existing_profile_context_verified']:[]),...(memoryProducerRetained&&table==='workspace_memory_outbox'?['existing_memory_event_no_consumer']:[])];
          const classified=classifyRestorationRow(table,row,{rows:restorationRows,preserved,evidence:localEvidence});
          item.record={...record,disposition:classified.disposition,evidence:[...localEvidence,...classified.evidence]};
          records[item.index]=item.record;
        }
      })
      .deferred();`);
 source=once(source,'  return {\n    complete: false,\n    safe: false,',`  for(let index=0;index<records.length;index++) { const record=records[index]!; if(!record.kind.startsWith('residue/'))continue;
    const classified=classifyRestorationResidue(record.kind,record.evidence);
    records[index]={...record,disposition:classified.disposition,evidence:[...record.evidence,...classified.evidence]};
  }
  if(!records.some(record=>record.kind.startsWith('residue/')&&record.disposition==='blocked')&&
     ![...blockers].some(reason=>reason.startsWith('RESIDUE:'))&&dataDir!==undefined)
    blockers.delete('NON_DATABASE_RESIDUE_UNVERIFIED');
  if(!restorationRecords.some(item=>item.record.disposition==='blocked')&&
     ![...blockers].some(reason=>reason.startsWith('BUDGET:')||reason.startsWith('SCHEMA:')||reason==='READ_ERROR'||reason==='UNKNOWN_OBJECT'))
    blockers.delete('OPAQUE_RUNTIME_METADATA_UNVERIFIED');
  try {
    if(!dataDir||inspectRestorationBoundary(dataDir,${JSON.stringify(supervisorSourceHash)},${JSON.stringify(supervisorModuleHash)}).version!==boundaryVersion)
      blockers.add('LOCAL_SUPERVISOR_BOUNDARY_CHANGED');
  } catch { blockers.add('LOCAL_SUPERVISOR_BOUNDARY_UNVERIFIED'); }
  const complete=blockers.size===0;
  return {
    complete,
    safe: complete && records.every(record=>record.disposition!=='blocked'),`);
 result.set('appointment-boot-inventory.ts',source);
 return result;
}
