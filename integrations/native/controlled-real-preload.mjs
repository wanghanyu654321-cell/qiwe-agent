import {createControlledModelFetch} from './controlled-real-model.ts';

const installed=new WeakSet();
export function installControlledRealModelFetch(env=process.env,target=globalThis){
 const invalid=()=>{throw Error('CONTROLLED_REAL_PRELOAD_INVALID');};
 const id=env.QIWE_PILOT_RUN_ID,raw=[env.QIWE_PILOT_MODEL_EXPIRES_AT,env.QIWE_PILOT_MODEL_REQUESTS,env.QIWE_PILOT_MODEL_OUTPUT_TOKENS];
 if(!/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(id??'')||raw.some(value=>typeof value!=='string'||!/^[1-9]\d*$/.test(value))||!target||typeof target.fetch!=='function'||installed.has(target))invalid();
 const [expiresAt,maxRequests,maxOutputTokens]=raw.map(Number);
 if(!Number.isSafeInteger(expiresAt)||expiresAt<=Date.now()||expiresAt>Date.now()+1800000||maxRequests>8||maxOutputTokens>1024)invalid();
 const guarded=createControlledModelFetch({admission:{mode:'controlled-real-pilot',environment:'local-test'},expiresAt,maxRequests,maxOutputTokens,transport:target.fetch.bind(target)});
 target.fetch=guarded.fetch;installed.add(target);return guarded;
}
