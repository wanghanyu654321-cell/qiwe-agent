import type { BigIntStats } from 'node:fs';
export function inspectExistingConfig(parentFd:number,relative:string,stat:BigIntStats,options:{webSessionSecret:string;pluginAutoScan:boolean}):string|undefined;
