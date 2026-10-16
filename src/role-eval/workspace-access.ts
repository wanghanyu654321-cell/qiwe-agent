function record(value:unknown):Record<string,unknown>{if(!value||typeof value!=='object'||Array.isArray(value))throw Error('workspace_response_invalid');return value as Record<string,unknown>;}
/** De-duplicate only within the current identity; stale reads cannot commit UI state. */
export function createWorkspaceReadGate(){
 let pending:{account:string;promise:Promise<void>}|null=null,sequence=0;
 return {run<T>(input:{account:string;current():string|undefined;start():void;read():Promise<T>;accept(value:T):void;reject(error:unknown):void}):Promise<void>{
  if(!input.account||input.current()!==input.account)return Promise.resolve();
  if(pending?.account===input.account)return pending.promise;
  const own=++sequence,current=()=>own===sequence&&input.current()===input.account;
  input.start();
  const promise=(async()=>{try{const value=await input.read();if(current())input.accept(value);}catch(error){if(current())input.reject(error);}})().finally(()=>{if(own===sequence)pending=null;});
  pending={account:input.account,promise};return promise;
 }};
}
export function parseOwnWorkspace(value:unknown):string|undefined{
 const own=Object.entries(record(record(value).groups)).filter(([,group])=>record(group).is_my_home===true);
 if(own.length>1)throw Error('ambiguous_home');
 const workspace=own[0]?.[0];
 if(workspace&&(!workspace.startsWith('web:')||workspace.length>200||/[\s\u0000#]/.test(workspace)))throw Error('invalid_home');
 return workspace;
}
export async function readOwnWorkspace(load:()=>Promise<unknown>,account:string,current:()=>string|undefined,signal:AbortSignal){
 const check=()=>{signal.throwIfAborted();if(!account||current()!==account)throw Error('account_changed');};
 for(let attempt=0;attempt<2;attempt++){
  check();let value:unknown;
  try{value=await load();}catch(error){check();const status=error&&typeof error==='object'?Reflect.get(error,'status'):undefined;if(attempt||![0,408,429,502,503,504].includes(Number(status)))throw error;
   await new Promise<void>((resolve,reject)=>{const abort=()=>{clearTimeout(timer);reject(signal.reason);};const timer=setTimeout(()=>{signal.removeEventListener('abort',abort);resolve();},500);signal.addEventListener('abort',abort,{once:true});});continue;}
  check();return parseOwnWorkspace(value);
 }
 throw Error('workspace_unavailable');
}
