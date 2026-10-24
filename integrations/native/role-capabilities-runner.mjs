import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {applyPiToolErrorBoundary,d4OriginalHashes,d4SkillHashes} from './role-capabilities-overlay.mjs';

/** Shared D4 source admission and test-only startup export; never changes originals. */
export function prepareOriginalPiRunner({source,root,skillRoot}) {
 const digest=bytes=>createHash('sha256').update(bytes).digest('hex');
 if(skillRoot)for(const id of ['beauty-local-content','vendor-content-strategy','vendor-copywriting']){
  if(digest(fs.readFileSync(path.join(skillRoot,id,'SKILL.md')))!==d4SkillHashes[id])throw Error('D4_SKILL_SOURCE_CHANGED: '+id);
  const destination=path.join(root,'skill-sources',id);fs.mkdirSync(destination,{recursive:true});fs.copyFileSync(path.join(skillRoot,id,'SKILL.md'),path.join(destination,'SKILL.md'));
 }
 const runnerSource=path.resolve(source,'../container/agent-runner');
 const runnerSourceHashes={};
 function runnerInventory(directory){for(const item of fs.readdirSync(path.join(runnerSource,directory),{withFileTypes:true})){
  const name=directory+'/'+item.name;
  if(item.isSymbolicLink())throw Error('D4_RUNNER_SOURCE_SYMLINK');
  if(item.isDirectory())runnerInventory(name);else if(!/\.(test|spec)\.ts$/.test(name))runnerSourceHashes[name]=digest(fs.readFileSync(path.join(runnerSource,name)));
 }}
 runnerInventory('src');runnerInventory('prompts');
 const runnerTree=digest(Object.entries(runnerSourceHashes).sort(([a],[b])=>a.localeCompare(b,'en')).map(([name,hash])=>name+'\0'+hash).join('\n'));
 if(runnerTree!=='6d8a8fdb9717820a10478c875d6b424ce452157ea17c94aaac26dad3e64f4d17')throw Error('D4_RUNNER_TREE_CHANGED');
 for(const [name,expected]of Object.entries(d4OriginalHashes))if(digest(fs.readFileSync(path.join(runnerSource,name)))!==expected)throw Error('D4_RUNNER_SOURCE_CHANGED: '+name);
 const runnerTarget=path.join(root,'runner');
 fs.mkdirSync(runnerTarget);
 fs.cpSync(path.join(runnerSource,'src'),path.join(runnerTarget,'src'),{recursive:true});
 fs.cpSync(path.join(runnerSource,'prompts'),path.join(runnerTarget,'prompts'),{recursive:true});
 fs.copyFileSync(path.join(runnerSource,'tsconfig.json'),path.join(runnerTarget,'tsconfig.json'));
 fs.copyFileSync(path.join(runnerSource,'package.json'),path.join(runnerTarget,'package.json'));
 fs.symlinkSync(path.join(runnerSource,'node_modules'),path.join(runnerTarget,'node_modules'),process.platform==='win32'?'junction':'dir');
 const toolFile=path.join(runnerTarget,'src/runtime/pi/pi-tools.ts');
 fs.writeFileSync(toolFile,applyPiToolErrorBoundary(fs.readFileSync(toolFile,'utf8')));
 const entryFile=path.join(runnerTarget,'src/pi-index.ts');
 let entry=fs.readFileSync(entryFile,'utf8').replaceAll('\r\n','\n');
 const startup="main().catch((error) => {\n  console.error(`[agent-runner] Fatal error in Pi main: ${String(error)}`);\n  process.exit(1);\n});";
 if(entry.split(startup).length!==2)throw Error('D4_RUNNER_STARTUP_ANCHOR_CHANGED');
 fs.writeFileSync(entryFile,entry.replace(startup,'export { runTurn };'));
 return {runnerTarget,runnerTree,runnerSourceHashes,toolFile,entryFile};
}
