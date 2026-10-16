import { createHash } from 'node:crypto';

type Definition = {key:string;payload:Record<string,unknown>&{name:string}};
export interface ProfilePort {
  list(): Promise<Record<string, unknown>[]>;
  /** Authorization preflight before acquiring a durable creation claim. */
  beforeCreate?():Promise<void>;
  create(payload: Record<string, unknown>): Promise<Record<string, unknown>>;
}
export interface CreationJournal {
  get(name: string): { payloadHash: string; state: 'pending' | 'resolved'; id?: string } | undefined;
  /** Must persist atomically before a POST; false means another invocation already owns this name. */
  begin(name: string, payloadHash: string): boolean;
  resolve(name: string, id: string): void;
}
function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${JSON.stringify(k)}:${stable(v)}`).join(',')}}`;
  return JSON.stringify(value) ?? 'undefined';
}
function assertMatch(row: Record<string, unknown>, definition: Definition, owner: string) {
  if (typeof row.id !== 'string' || row.owner_user_id !== owner) throw Error('profile_identity');
  for (const [key, value] of Object.entries(definition.payload)) {
    if (key === 'prompt_schema_version') continue; // Create-request discriminator, not a stored permission.
    if (stable(row[key]) !== stable(value)) throw Error(`profile_mismatch:${key}`);
  }
}
/** Native POST has no idempotency key. Unknown results are reconciled, never blindly retried. */
export async function installProfiles(port: ProfilePort, definitions: Definition[], trustedOwner: string, journal: CreationJournal) {
  const baseline = await port.list();
  if (new Set(definitions.map(d => d.payload.name)).size !== definitions.length) throw Error('duplicate_profile_names');
  const results: { key: string; id: string; replayed: boolean }[] = [];
  for (const definition of definitions) {
    let rows = (await port.list()).filter(r => r.name === definition.payload.name);
    if (rows.length > 1) throw Error('profile_name_conflict');
    let replayed = rows.length === 1;
    const payloadHash = createHash('sha256').update(stable(definition.payload)).digest('hex');
    const previous = journal.get(definition.payload.name);
    if (previous && previous.payloadHash !== payloadHash) throw Error('profile_pending_payload_changed');
    if (!rows.length) {
      // A prior timeout or concurrent invocation is never permission to POST again.
      if(previous)throw Error('profile_result_unknown');
      await port.beforeCreate?.();
      if (!journal.begin(definition.payload.name, payloadHash)) throw Error('profile_result_unknown');
      try { rows = [await port.create(definition.payload)]; }
      catch {
        // The only follow-up is a read of the same deterministic name/payload.
        rows = (await port.list()).filter(r => r.name === definition.payload.name);
        if (rows.length !== 1) throw Error('profile_result_unknown');
        replayed = true;
      }
    }
    const row = rows[0]!; assertMatch(row, definition, trustedOwner);
    if (journal.get(definition.payload.name)) journal.resolve(definition.payload.name, String(row.id));
    results.push({ key: definition.key, id: String(row.id), replayed });
  }
  const finalRows = await port.list();
  for (const original of baseline.filter(r => !results.some(result => result.id === r.id))) {
    const current = finalRows.find(r => r.id === original.id);
    if (!current || stable(current) !== stable(original)) throw Error('original_profile_changed');
  }
  return results;
}
