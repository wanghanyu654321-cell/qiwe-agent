/** Load the verifier's TypeScript compiler. Failures stay a fixed code. */
export async function loadVerifierTypescript(load=()=>import('typescript')){
 try{
  const loaded=await load();
  const typescript=loaded?.default??loaded;
  if(typeof typescript?.transpileModule!=='function')throw Error('FULL_HOST_TYPESCRIPT_UNAVAILABLE');
  return typescript;
 }catch(error){
  if(error?.message==='FULL_HOST_TYPESCRIPT_UNAVAILABLE')throw error;
  throw Error('FULL_HOST_TYPESCRIPT_UNAVAILABLE');
 }
}
