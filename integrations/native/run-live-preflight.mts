import fs from 'node:fs';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {runIsolatedSyntheticFormalPath} from './isolated-synthetic-pilot.mjs';
import {PILOT_PRIVATE_CONFIG_PATH,installVerifiedPilotPrivateConfig,runContainerPrivateInstall} from './pilot-private-bootstrap.mjs';

const args=process.argv.slice(2);
const known=new Set(['--isolated-synthetic','--private-file','--destination','--container']);
function flagValue(name){
 const index=args.indexOf(name);if(index<0)return undefined;
 const value=args[index+1];if(!value||value.startsWith('--'))throw Error('PILOT_PREFLIGHT_ARGUMENTS');
 return value;
}
function report(value){console.log(JSON.stringify(value));}
try{
 for(let index=0;index<args.length;index++){
  const token=args[index];
  if(!token.startsWith('--')||!known.has(token))throw Error('PILOT_PREFLIGHT_ARGUMENTS');
  if(token!=='--isolated-synthetic')index++;
 }
 const synthetic=args.includes('--isolated-synthetic');
 const privateFile=flagValue('--private-file'),destination=flagValue('--destination'),container=flagValue('--container');
 if(synthetic&&(privateFile||destination||container||args.includes('--controlled-real-pilot')))throw Error('ISOLATED_SYNTHETIC_REAL_CREDENTIAL');
 if(synthetic){
  if(args.length!==1)throw Error('ISOLATED_SYNTHETIC_ARGUMENTS');
  const result=await runIsolatedSyntheticFormalPath({args:['--isolated-synthetic'],env:process.env});
  report({status:result.status,order:result.order,restart:result.restart,reserve:result.reserve,disposed:result.disposed,reserved:result.reserved});
  fs.rmSync(result.root,{recursive:true,force:true});
 }else if(privateFile&&container){
  if(destination)throw Error('PILOT_PREFLIGHT_ARGUMENTS');
  const installed=runContainerPrivateInstall({execFileSync,docker:'docker',container,hostFile:path.resolve(privateFile),destination:PILOT_PRIVATE_CONFIG_PATH});
  report({status:'private-config-installed',uid:installed.uid,gid:installed.gid,mode:'0600',nlink:installed.nlink});
 }else if(privateFile){
  const installed=installVerifiedPilotPrivateConfig({hostFile:path.resolve(privateFile),destination:path.resolve(destination??PILOT_PRIVATE_CONFIG_PATH)});
  report({status:'private-config-installed',uid:installed.uid,gid:installed.gid,mode:'0600',nlink:installed.nlink});
 }else throw Error('PILOT_PREFLIGHT_ARGUMENTS');
}catch(error){
 const code=typeof error?.message==='string'&&/^[A-Z0-9_]{1,80}$/.test(error.message)?error.message:'PILOT_PREFLIGHT_FAILED';
 console.error(code);process.exitCode=1;
}
