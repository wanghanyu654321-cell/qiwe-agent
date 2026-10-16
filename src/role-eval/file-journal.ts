import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, openSync, writeFileSync, fsyncSync, closeSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import type { CreationJournal } from './install.js';

export class FileCreationJournal implements CreationJournal {
  constructor(private readonly directory: string) { mkdirSync(directory, { recursive: true, mode: 0o700 }); }
  private file(name: string) { return join(this.directory, createHash('sha256').update(name).digest('hex') + '.json'); }
  get(name: string): ReturnType<CreationJournal['get']> {
    try {
      const r = JSON.parse(readFileSync(this.file(name), 'utf8'));
      if (r.name !== name || !/^[a-f0-9]{64}$/.test(r.payloadHash) || !['pending', 'resolved'].includes(r.state)) throw Error('invalid_creation_journal');
      return r;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw error;
    }
  }
  begin(name: string, payloadHash: string): boolean {
    let fd: number;
    try { fd = openSync(this.file(name), 'wx', 0o600); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'EEXIST') return false; throw error; }
    try { writeFileSync(fd, JSON.stringify({ name, payloadHash, state: 'pending' })); fsyncSync(fd); }
    finally { closeSync(fd); }
    return true;
  }
  resolve(name: string, id: string): void {
    const current = this.get(name); if (!current) throw Error('missing_creation_journal');
    const temp = this.file(name) + '.' + randomUUID() + '.tmp';
    const fd = openSync(temp, 'wx', 0o600);
    try { writeFileSync(fd, JSON.stringify({ name, payloadHash: current.payloadHash, state: 'resolved', id })); fsyncSync(fd); }
    finally { closeSync(fd); }
    renameSync(temp, this.file(name));
  }
}
