/** Snapshot-only absence proof; not an authorization or skill-availability check. */
export function inspectExistingProfileContext(dataDir:string,ownerId:string,groups:readonly string[],allowStep?:()=>boolean):boolean;
