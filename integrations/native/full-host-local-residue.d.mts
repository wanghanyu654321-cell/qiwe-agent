import type fs from 'node:fs';
export interface SettledLocalSession {folder:string;sessionId:string;content:string;input:{id:string;content:string};}
export function settledLocalSessions(rows:ReadonlyMap<string,readonly Record<string,unknown>[]>,records:readonly {table:string;row:Record<string,unknown>;record:{evidence:readonly string[]}}[]):SettledLocalSession[];
export function inspectLocalRunnerResidue(name:string,relative:string,stat:fs.BigIntStats,context:readonly SettledLocalSession[],observedSessions:Set<string>):string|undefined;
