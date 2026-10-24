/** Pinned local verification adapter; opaque receipt is validated at runtime. */
export interface LocalDockerIdentity {runId:string;daemonId:string;volume:string;mountpoint:string;hostId:string;hostMounts:unknown[];oldContainerId:string;}
export function inspectLocalDockerReceipt(receipt:unknown):LocalDockerIdentity;
