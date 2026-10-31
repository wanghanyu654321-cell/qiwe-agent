import fs from 'node:fs';
import path from 'node:path';
// Placeholder only. This process does not read credentials, open a socket, or call a model.
const file=process.argv[2];
if(typeof file!=='string'||!path.isAbsolute(file))throw Error('ISOLATED_SYNTHETIC_INPUT_INVALID');
const body="ANTHROPIC_API_KEY='synthetic-placeholder'\nMINICLAW_AGENT_RUNTIME='pi'\n";
fs.mkdirSync(path.dirname(file),{recursive:true});
fs.writeFileSync(file,body,{mode:0o600,flag:'wx'});
