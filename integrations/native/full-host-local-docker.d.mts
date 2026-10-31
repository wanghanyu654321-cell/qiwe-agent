/** Pinned local verification adapter; opaque receipt is validated at runtime. */
export interface ControlledRealPilotScope {mode:'controlled-real-pilot';environment:'local-test';runId:string;expiresAt:number;networkName:string;}
export interface LocalDockerIdentity {runId:string;daemonId:string;volume:string;mountpoint:string;hostId:string;hostMounts:unknown[];oldContainerId:string;controlledRealPilot?:Readonly<ControlledRealPilotScope>;network?:Readonly<Record<string,unknown>>;}
export function validateControlledRealPilotScope(scope:unknown,runId:string):Readonly<ControlledRealPilotScope>;
export function inspectLocalDockerReceipt(receipt:unknown):LocalDockerIdentity;
