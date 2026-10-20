import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import {fileURLToPath} from 'node:url';import {spawnSync} from 'node:child_process';
import {anchors,transformNative} from './targeted-execution.mjs';
const source=process.argv[2];if(!source||!path.isAbsolute(source))throw Error('Supply absolute Native src directory');
const temp=fs.mkdtempSync(path.join(os.tmpdir(),'qiwe-native-diff-'));
try{
 for(const side of ['a','b'])fs.mkdirSync(path.join(temp,side));
 for(const name of Object.keys(anchors)){
  const bytes=fs.readFileSync(path.join(source,name));
  fs.writeFileSync(path.join(temp,'a',name),bytes.toString('utf8').replaceAll('\r\n','\n'));
  fs.writeFileSync(path.join(temp,'b',name),transformNative(name,bytes));
 }
 const result=spawnSync('git',['diff','--no-index','--no-color','--unified=0','--','a','b'],{cwd:temp,encoding:'utf8'});
 if(result.status!==1)throw Error(result.stderr||'Expected nonempty diff');
 const patch=result.stdout.replaceAll('a/a/','a/').replaceAll('b/b/','b/');
 fs.writeFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)),'targeted-execution.patch'),patch);
}finally{
 const resolved=fs.realpathSync(temp);if(path.dirname(resolved)!==fs.realpathSync(os.tmpdir())||!path.basename(resolved).startsWith('qiwe-native-diff-'))throw Error('Unsafe cleanup');
 fs.rmSync(resolved,{recursive:true,force:true});
}
