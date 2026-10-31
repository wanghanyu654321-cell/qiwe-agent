import {createRequire} from 'node:module';
import path from 'node:path';
import {createControlledModelFetch} from './controlled-real-model.ts';

const installed=new WeakSet();
const require=createRequire(import.meta.url);
export function installControlledRealModelFetch(env=process.env,target=globalThis){
 const invalid=()=>{throw Error('CONTROLLED_REAL_PRELOAD_INVALID');};
 const id=env.QIWE_PILOT_RUN_ID,raw=[env.QIWE_PILOT_MODEL_EXPIRES_AT,env.QIWE_PILOT_MODEL_REQUESTS,env.QIWE_PILOT_MODEL_OUTPUT_TOKENS];
 if(!/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(id??'')||raw.some(value=>typeof value!=='string'||!/^[1-9]\d*$/.test(value))||!target||typeof target.fetch!=='function'||installed.has(target))invalid();
 const [expiresAt,maxRequests,maxOutputTokens]=raw.map(Number);
 if(!Number.isSafeInteger(expiresAt)||expiresAt<=Date.now()||expiresAt>Date.now()+1800000||maxRequests>8||maxOutputTokens>1024)invalid();
 // The runner mount contains only this file and the model module. The durable
 // ledger stays on the host and is loaded only when that host path is configured.
 let reserveAccepted;
 if(env.QIWE_PILOT_MODEL_LEDGER!==undefined){
  if(typeof env.QIWE_PILOT_MODEL_LEDGER!=='string'||!path.isAbsolute(env.QIWE_PILOT_MODEL_LEDGER))invalid();
  const budget=require('./controlled-real-run-budget.mjs');
  const expected={runId:id,maxRequests,expiresAt};
  budget.openPilotRunLedger(env.QIWE_PILOT_MODEL_LEDGER,expected);
  reserveAccepted=()=>budget.reservePilotModelCall(env.QIWE_PILOT_MODEL_LEDGER,expected);
 }
 const original=target.fetch.bind(target);
 const guarded=createControlledModelFetch({admission:{mode:'controlled-real-pilot',environment:'local-test'},expiresAt,maxRequests,maxOutputTokens,transport:async request=>{if(reserveAccepted)reserveAccepted();return original(request);}});
 target.fetch=guarded.fetch;installed.add(target);return guarded;
}
