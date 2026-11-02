import {afterAll,afterEach,beforeAll,beforeEach,expect,it,vi} from 'vitest';
import path from 'node:path';
import net from 'node:net';
import dns from 'node:dns';
import dgram from 'node:dgram';
import childProcess from 'node:child_process';
import {syncBuiltinESMExports} from 'node:module';
import Database from 'better-sqlite3';
import {scanAppointmentBootMetadata} from '../src/appointment-boot-inventory.js';

const mandatory=['NON_DATABASE_RESIDUE_UNVERIFIED','EXTERNAL_WRITERS_UNVERIFIED','WRITER_COVERAGE_INCOMPLETE','OPAQUE_RUNTIME_METADATA_UNVERIFIED'];
const mode=process.env.QIWE_RECOVERY_SCHEMA;
const intake=mode==='intake'||mode==='execution',execution=mode==='execution';
let baseline:Buffer,sql:Database.Database;
const attempts:string[]=[];
// Only the original DB initializer is loaded, under a disposable cwd and fixed
// synthetic config. No original main, scheduler, queue, provider or model runs.
beforeAll(async()=>{
 for(const [object,names,kind] of [
  [net.Socket.prototype,['connect'],'tcp'],[net.Server.prototype,['listen'],'listen'],
  [dns,Object.keys(dns).filter(n=>n.startsWith('resolve')||['reverse','lookup','lookupService'].includes(n)),'dns'],
  [dns.promises,Object.keys(dns.promises).filter(n=>n.startsWith('resolve')||['reverse','lookup','lookupService'].includes(n)),'dns'],
  [dgram.Socket.prototype,['send','connect','bind'],'udp'],
  [childProcess,['exec','execFile','execSync','execFileSync','spawn','spawnSync','fork'],'child'],
 ] as const)for(const name of names)vi.spyOn(object as any,name as any).mockImplementation((()=>{attempts.push(kind);throw Error('RECOVERY_IO_FORBIDDEN:'+kind);}) as any);
 syncBuiltinESMExports();
 const db=await import('../src/db.js'),config=await import('../src/config.js');
 expect(db.CURRENT_SCHEMA_VERSION).toBe(execution?72:intake?70:69);
 db.initDatabase();db.closeDatabase();
 const initialized=new Database(path.join(config.STORE_DIR,'messages.db'),{fileMustExist:true});
 // SQLite-deserialized in-memory databases cannot reopen a persisted WAL file.
 // This fixture-only checkpoint changes no original producer or recovery code.
 initialized.pragma('journal_mode = DELETE');
 baseline=initialized.serialize();initialized.close();
 expect(attempts).toEqual([]);
});
beforeEach(()=>{sql=new Database(baseline);});
afterEach(()=>sql.close());
afterAll(()=>{vi.restoreAllMocks();syncBuiltinESMExports();});

function blocked(report:ReturnType<typeof scanAppointmentBootMetadata>){
 expect(report.complete).toBe(false);expect(report.safe).toBe(false);
 expect(report.blockers).toEqual(expect.arrayContaining(mandatory));
 expect(report.records.every(r=>r.disposition==='blocked'||r.kind==='observation/sqlite_snapshot')).toBe(true);
}
const rows=(report:ReturnType<typeof scanAppointmentBootMetadata>,table:string)=>report.records.filter(r=>r.kind.endsWith('/'+table));
function seed(count=1){
 if(!intake)return;
 const receipt=sql.prepare('INSERT INTO wecom_conversation_receipts VALUES (?,?,?,?,?,?,?,?,?,?,?)');
 const run=execution?sql.prepare('INSERT INTO wecom_conversation_execution VALUES (?,?,?,?,?,?,?,?,?)'):undefined;
 const result=execution?sql.prepare('INSERT INTO wecom_conversation_results VALUES (?,?,?,?,?,?,?,?)'):undefined;
 sql.transaction(()=>{for(let n=0;n<count;n++){
  const id='synthetic-receipt-'+String(n).padStart(5,'0');
  receipt.run(id,'synthetic-message-'+n,'2026-10-23T00:00:00Z','private-origin-never-return','synthetic-fingerprint','synthetic-text-hash','{"private":"actor-never-return"}','marketing','web:synthetic-space','synthetic-profile','synthetic-selection');
  run?.run(id,'web:synthetic-space','synthetic-message-'+n,['queued','running','cancelling','cancelled','completed','failed','unknown'][n%7],'synthetic-query-'+n,'synthetic-turn-'+n,'private-session-never-return','["private-input-never-return"]',1);
  result?.run(id,1,'synthetic-query-'+n,'synthetic-turn-'+n,'private-session-never-return','["private-source-never-return"]','synthetic-digest-'+n,'private-answer-never-return');
 }})();
}

it('rejects real socket overloads, listeners, DNS, UDP and child execution in this fixture',()=>{
 for(const target of [{host:'192.0.2.1',port:443},{host:'::1',port:443},{path:'/synthetic.sock'},{path:'\\\\.\\pipe\\synthetic'}])expect(()=>new net.Socket().connect(target as any)).toThrow('RECOVERY_IO_FORBIDDEN:tcp');
 expect(()=>new net.Socket().connect(443,'192.0.2.1')).toThrow('RECOVERY_IO_FORBIDDEN:tcp');
 for(const target of [{host:'127.0.0.1',port:0},{host:'::1',port:0},'/synthetic.sock'])expect(()=>net.createServer().listen(target as any)).toThrow('RECOVERY_IO_FORBIDDEN:listen');
 expect(()=>net.createServer().listen(0,'127.0.0.1')).toThrow('RECOVERY_IO_FORBIDDEN:listen');
 expect(()=>dns.resolve('synthetic.invalid',()=>{})).toThrow('RECOVERY_IO_FORBIDDEN:dns');
 expect(()=>dns.promises.lookup('synthetic.invalid')).toThrow('RECOVERY_IO_FORBIDDEN:dns');
 const udp=dgram.createSocket('udp4');
 for(const call of [()=>udp.send('x',1234,'192.0.2.1'),()=>udp.connect(1234,'192.0.2.1'),()=>udp.bind(0,'127.0.0.1')])expect(call).toThrow('RECOVERY_IO_FORBIDDEN:udp');udp.close();
 expect(()=>childProcess.spawn('synthetic')).toThrow('RECOVERY_IO_FORBIDDEN:child');attempts.length=0;
});
it('enumerates every existing and new table row past two page boundaries while refusing recovery',()=>{
 seed(513);const before=sql.serialize(),report=scanAppointmentBootMetadata(sql);
 blocked(report);expect(report.blockers).not.toContain('UNKNOWN_OBJECT');
 expect(report.blockers.filter(b=>b.startsWith('SCHEMA:'))).toEqual([]);
 expect(rows(report,'router_state').length).toBeGreaterThan(0);
 for(const table of ['wecom_conversation_receipts',...(execution?['wecom_conversation_execution','wecom_conversation_results']:[])]){
  const observed=rows(report,table);expect(observed).toHaveLength(intake?513:0);
  expect(new Set(observed.map(r=>r.key)).size).toBe(observed.length);
 }
 const text=JSON.stringify(report);
 for(const secret of ['private-origin-never-return','actor-never-return','private-session-never-return','private-input-never-return','private-source-never-return','private-answer-never-return','synthetic-receipt-','web:synthetic-space'])expect(text).not.toContain(secret);
 expect(sql.serialize()).toEqual(before);expect(attempts).toEqual([]);
 if(execution)for(const state of ['queued','running','cancelling','cancelled','completed','failed','unknown'])
  expect(rows(report,'wecom_conversation_execution').some(r=>r.evidence.includes('observed:state='+state))).toBe(true);
});
it.skipIf(!execution)('enumerates composite result keys across pages for one receipt without dropping revisions',()=>{
 seed();const insert=sql.prepare('INSERT INTO wecom_conversation_results VALUES (?,?,?,?,?,?,?,?)');
 sql.transaction(()=>{for(let revision=2;revision<=514;revision++)insert.run('synthetic-receipt-00000',revision,'query-'+revision,'turn',null,'[]','digest-'+revision,'private-answer-never-return');})();
 const report=scanAppointmentBootMetadata(sql);blocked(report);
 const observed=rows(report,'wecom_conversation_results');expect(observed).toHaveLength(514);
 expect(new Set(observed.map(r=>r.key)).size).toBe(514);
});
it.skipIf(!intake)('binds metadata changes to the same record version without turning any state into terminal',()=>{
 seed();const before=scanAppointmentBootMetadata(sql);
 sql.prepare("UPDATE wecom_conversation_receipts SET selection_id='synthetic-next-selection'").run();
 if(execution)sql.prepare("UPDATE wecom_conversation_execution SET state='cancelled'").run();
 const after=scanAppointmentBootMetadata(sql);blocked(after);
 for(const table of ['wecom_conversation_receipts',...(execution?['wecom_conversation_execution']:[])]){
  expect(rows(after,table)[0].key).toBe(rows(before,table)[0].key);
  expect(rows(after,table)[0].version).not.toBe(rows(before,table)[0].version);
  expect(rows(after,table)[0].disposition).toBe('blocked');
 }
});
it.each(['table','view','trigger'])('retains unknown %s rejection and never grants partial row coverage',kind=>{
 seed();
 sql.exec(kind==='table'?'CREATE TABLE synthetic_unknown(id TEXT)':kind==='view'?'CREATE VIEW synthetic_unknown AS SELECT key FROM router_state':'CREATE TRIGGER synthetic_unknown AFTER UPDATE ON router_state BEGIN SELECT 1; END');
 const report=scanAppointmentBootMetadata(sql);blocked(report);expect(report.blockers).toContain('UNKNOWN_OBJECT');
 expect(report.records.filter(r=>!r.kind.startsWith('observation/'))).toHaveLength(0);
});
it.skipIf(!intake)('refuses altered known table schemas and missing expected tables',()=>{
 seed();sql.exec('ALTER TABLE wecom_conversation_receipts ADD COLUMN synthetic_extra TEXT');
 let report=scanAppointmentBootMetadata(sql);blocked(report);expect(report.blockers).toContain('SCHEMA:wecom_conversation_receipts');
 expect(rows(report,'wecom_conversation_receipts')).toHaveLength(0);
 sql.exec('DROP TABLE wecom_conversation_receipts');report=scanAppointmentBootMetadata(sql);blocked(report);
 expect(report.blockers).toContain('SCHEMA:wecom_conversation_receipts');
});
it.skipIf(!intake)('refuses invalid new metadata and unknown execution states',()=>{
 seed();sql.prepare("UPDATE wecom_conversation_receipts SET receipt_id=''").run();
 let report=scanAppointmentBootMetadata(sql);blocked(report);expect(report.blockers).toContain('INVALID_KEY:wecom_conversation_receipts');
 expect(rows(report,'wecom_conversation_receipts')).toHaveLength(0);
 if(execution){
  sql.prepare("UPDATE wecom_conversation_execution SET state='synthetic-future-state'").run();
  sql.prepare('UPDATE wecom_conversation_results SET revision=1.5').run();
  report=scanAppointmentBootMetadata(sql);blocked(report);
  expect(report.blockers).toEqual(expect.arrayContaining(['UNKNOWN_STATE:wecom_conversation_execution','INVALID_KEY:wecom_conversation_results']));
  sql.prepare("UPDATE wecom_conversation_execution SET state='unknown',batch_size=1.5").run();
  report=scanAppointmentBootMetadata(sql);blocked(report);
  expect(report.blockers).toContain('INVALID_METADATA:wecom_conversation_execution');
 }
});
it.skipIf(!intake)('applies the original byte budget before transferring oversized new projected metadata',()=>{
 seed();sql.prepare('UPDATE wecom_conversation_receipts SET selection_id=?').run('x'.repeat(12*1024*1024));
 const report=scanAppointmentBootMetadata(sql);blocked(report);expect(report.blockers).toContain('BUDGET:BYTES');
 expect(rows(report,'wecom_conversation_receipts')).toHaveLength(0);
});
it.skipIf(!intake)('applies the original total row budget to the newly registered rows',()=>{
 sql.exec(`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM n WHERE i<100001)
 INSERT INTO wecom_conversation_receipts SELECT 'synthetic-'||i,'message','2026-10-23','origin','fingerprint','hash','{}','marketing','web:synthetic','profile','selection' FROM n`);
 const report=scanAppointmentBootMetadata(sql);blocked(report);expect(report.blockers).toContain('BUDGET:ROWS');
 expect(rows(report,'wecom_conversation_receipts')).toHaveLength(0);
});
it.skipIf(!intake)('retains original read-error failure when a newly projected table cannot be read',()=>{
 seed();const prepare=sql.prepare.bind(sql);
 const fault=vi.spyOn(sql,'prepare').mockImplementation(((query:string)=>{
  if(query.includes('FROM main."wecom_conversation_receipts"'))throw Error('synthetic-reader-failure');
  return prepare(query);
 }) as typeof sql.prepare);
 try{const report=scanAppointmentBootMetadata(sql);blocked(report);expect(report.blockers).toContain('READ_ERROR');}
 finally{fault.mockRestore();}
});
