import type { Person } from './performance-store.js';

export interface AliasRow { storeId: string; alias: string; personId: string; }

/** Exact display name or alias inside one store. Zero or several matches stay unresolved. */
export function matchPerson(people: readonly Person[], aliases: readonly AliasRow[], storeId: string, token: string): Person | null {
  const name = token.trim();
  if (!name) return null;
  const ids = new Set<string>();
  for (const person of people) {
    if (person.active && person.storeId === storeId && person.displayName === name) ids.add(person.personId);
  }
  for (const alias of aliases) {
    if (alias.storeId === storeId && alias.alias === name) ids.add(alias.personId);
  }
  if (ids.size !== 1) return null;
  const personId = [...ids][0]!;
  return people.find(person => person.personId === personId && person.active && person.storeId === storeId) ?? null;
}
