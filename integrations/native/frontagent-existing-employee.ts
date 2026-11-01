import fs from 'node:fs';
import {createHash} from 'node:crypto';
import {DatabaseSync, type SQLInputValue} from 'node:sqlite';

const tableNames = ['users','registered_groups','agent_profiles','workspace_agent_profiles','agent_profile_prompt_versions'] as const;
type Table = typeof tableNames[number];
type Row = Record<string, SQLInputValue>;
type Column = {name: string; type: string; notnull: number; dflt_value: string | null; pk: number};
const primaryKeys: Record<Table,string> = {users:'id',registered_groups:'jid',agent_profiles:'id',workspace_agent_profiles:'group_folder',agent_profile_prompt_versions:'id'};
// Fixed Native DB contract: source columns outside these five original tables are never accepted.
const allowedColumns: Record<Table,readonly string[]> = {
  users: 'id username password_hash display_name role status permissions must_change_password disable_reason notes avatar_emoji avatar_color avatar_url ai_name ai_avatar_emoji ai_avatar_color ai_avatar_url default_require_mention created_at updated_at last_login_at deleted_at subscription_plan_id'.split(' '),
  registered_groups: 'jid name folder added_at container_config created_by is_home execution_mode custom_cwd init_source_path init_git_url avatar_url selected_skills target_agent_id target_main_jid reply_policy require_mention mcp_mode selected_mcps activation_mode audience_mode owner_im_id owner_claim_source conversation_source conversation_nav_mode binding_mode native_context_type feishu_chat_mode feishu_group_message_type sender_allowlist channel_account_id'.split(' '),
  agent_profiles: 'id owner_user_id name identity_prompt soul_prompt agents_prompt tools_prompt prompt_mode include_claude_preset avatar_emoji avatar_color avatar_url model_config_id runtime_policy identity_hash version is_default status created_at updated_at'.split(' '),
  workspace_agent_profiles: 'group_folder agent_profile_id interaction_mode created_at updated_at'.split(' '),
  agent_profile_prompt_versions: 'id agent_profile_id version name identity_prompt soul_prompt agents_prompt tools_prompt prompt_mode identity_hash change_source restored_from_version created_at'.split(' '),
};
const roleKeys = ['reception','frontdesk','marketing','ads','manager','qa','training'];
const promptFields = ['name','identity_prompt','soul_prompt','agents_prompt','tools_prompt','prompt_mode','identity_hash'] as const;
function requireState(condition: unknown, code: string): asserts condition { if (!condition) throw Error('R2_RESTORE_'+code); }
function object(value: unknown): Record<string,unknown> { requireState(value !== null && typeof value === 'object' && !Array.isArray(value),'INVALID_OBJECT');return value as Record<string,unknown>; }
function array(value: unknown): unknown[] { requireState(Array.isArray(value),'INVALID_ARRAY');return value; }
function nonempty(value: unknown): value is string { return typeof value === 'string' && value.trim().length > 0; }
function integer(value: unknown): value is number { return typeof value === 'number' && Number.isSafeInteger(value) && value > 0; }
function exactKeys(value: Record<string,unknown>, keys: readonly string[]): boolean { return Object.keys(value).length === keys.length && keys.every(key=>Object.hasOwn(value,key)); }
function quote(name: string): string { requireState(/^[a-z][a-z0-9_]*$/.test(name),'INVALID_COLUMN');return '"'+name+'"'; }
function unique(rows: Row[], key: string): boolean { return rows.every(row=>nonempty(row[key])) && new Set(rows.map(row=>row[key])).size === rows.length; }

export interface RestoreExistingEmployeeOptions {
  databasePath: string;
  actorId: string;
  exportBytes: Uint8Array;
  /** Supplied separately from the trusted export receipt; never read from the payload itself. */
  expectedSha256: string;
  /** Trusted operator scope, independent of exported ACL rows. */
  expectedScope: {tenantId: string; storeId: string; instanceId: string};
}
export interface ExistingEmployeeRestoreResult {
  accountId: string;
  homeJid: string;
  profileIds: string[];
  workspaceJids: string[];
  imported: Record<Table,number>;
  reused: Record<Table,number>;
}

/** Operator-only import into an already stopped, boundary-verified R1 copy. This never starts
 * Native, provisions accounts, restores sessions, or writes the exported business ACL/newbot binding.
 * All values remain original. Any conflict rejects the entire synchronous transaction.
 */
export function restoreExistingFrontagentEmployee(options: RestoreExistingEmployeeOptions): ExistingEmployeeRestoreResult {
  const bytes = Buffer.from(options.exportBytes);
  requireState(bytes.length > 0 && bytes.length <= 16 * 1024 * 1024,'INVALID_EXPORT_SIZE');
  requireState(/^[a-f0-9]{64}$/i.test(options.expectedSha256) && createHash('sha256').update(bytes).digest('hex') === options.expectedSha256.toLowerCase(),'HASH_MISMATCH');
  let payload: Record<string,unknown>;
  try { payload = object(JSON.parse(bytes.toString('utf8'))); } catch { throw Error('R2_RESTORE_INVALID_EXPORT'); }
  requireState(payload.format === 'frontagent-existing-employee-v1' && nonempty(payload.runId),'INVALID_FORMAT');
  requireState(object(payload.source).unchangedAfterRead === true,'UNSTABLE_SOURCE');
  const accountId=payload.accountId,homeJid=payload.homeJid;
  requireState(nonempty(accountId) && nonempty(homeJid) && homeJid.startsWith('web:') && nonempty(options.actorId) && options.actorId !== accountId,'INVALID_IDENTITY');
  const trustedScope=object(options.expectedScope);
  requireState(['tenantId','storeId','instanceId'].every(key=>nonempty(trustedScope[key])),'INVALID_SCOPE');
  const authority=object(payload.authority),bindings=array(authority.bindings);
  requireState(bindings.length === 1,'ACL_NOT_UNIQUE');
  const binding=object(bindings[0]);
  requireState(binding.tenant_id === trustedScope.tenantId && binding.store_id === trustedScope.storeId && binding.instance_id === trustedScope.instanceId && binding.platform_user_id === accountId && binding.workspace_jid === homeJid && binding.role === 'staff' && binding.active === true && integer(binding.version),'ACL_SCOPE_MISMATCH');
  requireState(['id','subject_id','conversation_id'].every(key=>nonempty(binding[key])) && ['can_submit','can_decide','can_notify','can_takeover','can_verify'].every(key=>typeof binding[key] === 'boolean'),'INVALID_ACL');
  array(authority.oldAppMembers); // Evidence retained only; never interpreted as a newbot binding.
  requireState(payload.newBotBinding === 'not_exported_old_app_only','NEWBOT_BINDING_NOT_ALLOWED');
  const tablesObject=object(payload.tables),schemaObject=object(payload.schema);
  requireState(exactKeys(tablesObject,tableNames) && exactKeys(schemaObject,tableNames),'TABLE_SET_MISMATCH');
  const tables={} as Record<Table,Row[]>,schemas={} as Record<Table,Column[]>;
  for (const table of tableNames) {
    const columns=array(schemaObject[table]).map(value=>{
      const c=object(value);
      requireState(nonempty(c.name) && allowedColumns[table].includes(c.name) && typeof c.type === 'string' && (c.notnull===0 || c.notnull===1) && (c.pk===0 || c.pk===1) && (c.dflt_value===null || typeof c.dflt_value==='string'),'INVALID_SCHEMA');
      return c as unknown as Column;
    });
    requireState(columns.length > 0 && new Set(columns.map(c=>c.name)).size===columns.length && columns.filter(c=>c.pk).length===1 && columns.find(c=>c.pk)?.name===primaryKeys[table],'INVALID_PRIMARY_KEY');
    schemas[table]=columns;
    tables[table]=array(tablesObject[table]).map(value=>{
      const row=object(value);
      requireState(exactKeys(row,columns.map(c=>c.name)) && Object.values(row).every(v=>v===null || typeof v==='string' || (typeof v==='number' && Number.isFinite(v) && (!Number.isInteger(v) || Number.isSafeInteger(v)))),'INVALID_ROW');
      return row as Row;
    });
    requireState(unique(tables[table],primaryKeys[table]),'DUPLICATE_PRIMARY_KEY');
  }
  const users=tables.users,groups=tables.registered_groups,profiles=tables.agent_profiles,links=tables.workspace_agent_profiles,versions=tables.agent_profile_prompt_versions;
  requireState(users.length===1 && users[0]?.id===accountId && nonempty(users[0].username) && nonempty(users[0].password_hash) && users[0].role==='member' && users[0].status==='active' && users[0].must_change_password===0 && !users[0].deleted_at,'INVALID_EMPLOYEE');
  requireState(groups.length===8 && unique(groups,'folder') && groups.every(g=>g.created_by===accountId && g.execution_mode==='container' && (g.is_home===0 || g.is_home===1)) && groups.filter(g=>g.is_home===1).length===1 && groups.find(g=>g.is_home===1)?.jid===homeJid,'INVALID_HOME_OR_WORKSPACES');
  requireState(profiles.length===8 && profiles.every(p=>p.owner_user_id===accountId && p.status==='active' && integer(p.version) && (p.is_default===0 || p.is_default===1)) && profiles.filter(p=>p.is_default===1).length===1,'INVALID_PROFILES');
  const byProfile=new Map(profiles.map(p=>[p.id,p])),byGroup=new Map(groups.map(g=>[g.jid,g]));
  requireState(links.length===8 && unique(links,'agent_profile_id') && links.every(l=>groups.some(g=>g.folder===l.group_folder) && byProfile.has(l.agent_profile_id) && ['assistant','proactive'].includes(String(l.interaction_mode))),'INVALID_LINKS');
  const byFolder=new Map(links.map(l=>[l.group_folder,l]));
  requireState(byFolder.get(byGroup.get(homeJid)!.folder)?.agent_profile_id===profiles.find(p=>p.is_default===1)?.id,'INVALID_HOME_PROFILE');
  const roles=array(payload.roles).map(object);
  requireState(roles.length===7 && new Set(roles.map(r=>r.key)).size===7 && roles.every(r=>roleKeys.includes(String(r.key)) && nonempty(r.id) && nonempty(r.workspaceJid) && r.workspaceJid!==homeJid && byGroup.has(r.workspaceJid) && byFolder.get(byGroup.get(r.workspaceJid)!.folder)?.agent_profile_id===r.id && Array.isArray(r.skills) && r.skills.every(s=>nonempty(s) && !s.includes('/') && !s.includes('\\') && !s.includes('..'))) && new Set(roles.map(r=>r.id)).size===7 && new Set(roles.map(r=>r.workspaceJid)).size===7,'INVALID_ROLES');
  requireState(versions.length>=8 && versions.length<=10000 && versions.every(v=>byProfile.has(v.agent_profile_id) && integer(v.version) && Number(v.version)<=Number(byProfile.get(v.agent_profile_id)!.version)) && new Set(versions.map(v=>JSON.stringify([v.agent_profile_id,v.version]))).size===versions.length,'INVALID_PROMPT_VERSIONS');
  for (const profile of profiles) {
    const current=versions.filter(v=>v.agent_profile_id===profile.id && v.version===profile.version);
    requireState(current.length===1 && promptFields.every(field=>typeof profile[field]==='string' && profile[field]===current[0]![field]),'CURRENT_PROMPT_VERSION_MISMATCH');
    // Model configuration is deliberately excluded from this narrowly scoped recovery.
    requireState(profile.model_config_id===null || profile.model_config_id===undefined,'EXCLUDED_MODEL_REFERENCE');
  }
  requireState(fs.existsSync(options.databasePath) && fs.statSync(options.databasePath).isFile() && fs.statSync(options.databasePath).size>0,'TARGET_DATABASE_MISSING');
  fs.accessSync(options.databasePath,fs.constants.R_OK|fs.constants.W_OK);
  const db=new DatabaseSync(options.databasePath);
  let transaction=false;
  try {
    db.exec('PRAGMA foreign_keys=ON; BEGIN IMMEDIATE');transaction=true;
    requireState(db.prepare('PRAGMA foreign_keys').get()?.foreign_keys===1,'FOREIGN_KEYS_DISABLED');
    const quick=db.prepare('PRAGMA quick_check').all();requireState(quick.length===1 && quick[0]?.quick_check==='ok','TARGET_QUICK_CHECK_FAILED');
    for (const table of tableNames) {
      requireState(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table),'TARGET_TABLE_MISSING');
      requireState(!db.prepare("SELECT 1 FROM sqlite_master WHERE type='trigger' AND tbl_name=?").get(table),'TARGET_TRIGGER_NOT_ALLOWED');
      const target=db.prepare('PRAGMA table_info('+quote(table)+')').all() as unknown as Column[];
      const source=schemas[table];
      requireState(target.filter(c=>c.pk).length===1 && target.find(c=>c.pk)?.name===primaryKeys[table],'TARGET_PRIMARY_KEY_MISMATCH');
      requireState(source.every(c=>target.some(t=>t.name===c.name && t.type.toUpperCase()===c.type.toUpperCase() && t.pk===c.pk)) && target.filter(c=>!source.some(s=>s.name===c.name)).every(c=>c.pk===0 && (c.notnull===0 || c.dflt_value!==null)),'TARGET_SCHEMA_INCOMPATIBLE');
    }
    const actor=db.prepare('SELECT * FROM users WHERE id=?').get(options.actorId);
    requireState(actor?.role==='admin' && actor.status==='active' && actor.must_change_password===0 && !actor.deleted_at,'ACTIVE_ADMIN_REQUIRED');
    // Native has no declared FK on these tables: enforce identity ownership and exclusive
    // folder/profile associations explicitly instead of relying only on PRAGMA foreign_keys.
    const collision=db.prepare('SELECT id FROM users WHERE username=? AND id<>?').get(users[0]!.username!,accountId);
    requireState(!collision,'USERNAME_CONFLICT');
    for (const group of groups) {
      requireState(!db.prepare('SELECT jid FROM registered_groups WHERE folder=? AND jid<>?').get(group.folder!,group.jid!),'FOLDER_CONFLICT');
      requireState(!group.channel_account_id && !group.target_agent_id && !group.target_main_jid,'EXCLUDED_WORKSPACE_REFERENCE');
    }
    const wantedGroups=new Set(groups.map(g=>g.jid)),wantedProfiles=new Set(profiles.map(p=>p.id));
    requireState(db.prepare('SELECT jid FROM registered_groups WHERE created_by=?').all(accountId).every(g=>wantedGroups.has(g.jid as string)) && db.prepare('SELECT id FROM agent_profiles WHERE owner_user_id=?').all(accountId).every(p=>wantedProfiles.has(p.id as string)),'TARGET_OWNER_SET_CONFLICT');
    for (const link of links) requireState(!db.prepare('SELECT group_folder FROM workspace_agent_profiles WHERE agent_profile_id=? AND group_folder<>?').get(link.agent_profile_id!,link.group_folder!),'TARGET_PROFILE_LINK_CONFLICT');
    for (const version of versions) requireState(!db.prepare('SELECT id FROM agent_profile_prompt_versions WHERE agent_profile_id=? AND version=? AND id<>?').get(version.agent_profile_id!,version.version!,version.id!),'TARGET_VERSION_CONFLICT');
    const wantedVersionIds=new Set(versions.map(v=>v.id));
    for (const profile of profiles) requireState(db.prepare('SELECT id FROM agent_profile_prompt_versions WHERE agent_profile_id=?').all(profile.id!).every(v=>wantedVersionIds.has(v.id as string)),'TARGET_VERSION_SET_CONFLICT');
    const imported=Object.fromEntries(tableNames.map(t=>[t,0])) as Record<Table,number>,reused={...imported};
    // Profiles precede links and versions; groups precede links. No upsert or REPLACE is used.
    for (const table of tableNames) {
      const columns=schemas[table].map(c=>c.name),pk=primaryKeys[table];
      for (const row of tables[table]) {
        const existing=db.prepare('SELECT * FROM '+quote(table)+' WHERE '+quote(pk)+'=?').get(row[pk]!);
        if (existing) {requireState(columns.every(c=>existing[c]===row[c]),'EXISTING_ROW_CONFLICT');reused[table]++;continue;}
        db.prepare('INSERT INTO '+quote(table)+' ('+columns.map(quote).join(',')+') VALUES ('+columns.map(()=>'?').join(',')+')').run(...columns.map(c=>row[c]!));
        const inserted=db.prepare('SELECT * FROM '+quote(table)+' WHERE '+quote(pk)+'=?').get(row[pk]!);
        requireState(inserted && columns.every(c=>inserted[c]===row[c]),'INSERT_CHANGED_ORIGINAL_VALUE');
        imported[table]++;
      }
    }
    for(const table of tableNames) requireState(db.prepare('PRAGMA foreign_key_check('+quote(table)+')').all().length===0,'MISSING_REFERENCE');
    db.exec('COMMIT');transaction=false;
    return {accountId,homeJid,profileIds:profiles.map(p=>String(p.id)),workspaceJids:groups.map(g=>String(g.jid)),imported,reused};
  } catch (error) {
    if(transaction)db.exec('ROLLBACK');
    // SQLite diagnostics can echo CHECK contents; keep credentials and prompts out of errors.
    if(error instanceof Error && error.message.startsWith('R2_RESTORE_'))throw error;
    throw Error('R2_RESTORE_TARGET_CONFLICT_OR_MISSING_REFERENCE');
  } finally {db.close();}
}
