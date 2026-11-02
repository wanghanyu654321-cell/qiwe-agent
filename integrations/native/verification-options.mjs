import path from 'node:path';
/** Verification modes are explicit; an unknown option must never fall back to mocks. */
export function nativeVerificationOptions(args){
 const invalid=()=>{throw Error('Invalid Native verification arguments');};
 const [source,...rest]=args;if(!source||!path.isAbsolute(source))invalid();
 const result={source,driver:undefined,overlay:undefined,typecheck:false,unpatched:false},seen=new Set();
 for(let i=0;i<rest.length;i++){
  const flag=rest[i];if(seen.has(flag))invalid();seen.add(flag);
  if(flag==='--typecheck')result.typecheck=true;
  else if(flag==='--unpatched')result.unpatched=true;
  else if(flag==='--sqlite-driver'||flag==='--host-overlay'){
   const value=rest[++i];if(!value||!path.isAbsolute(value))invalid();
   result[flag==='--sqlite-driver'?'driver':'overlay']=value;
  }else invalid();
 }
 if(result.unpatched&&result.overlay)invalid();return Object.freeze(result);
}
