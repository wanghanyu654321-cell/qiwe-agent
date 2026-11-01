import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import * as shell from './original-shell.mjs';
const original=fs.readFileSync(new URL('../../../claw-agent-phase-one/.local/full-instance/stage/app/container/Dockerfile',import.meta.url),'utf8');
const npmBefore='    && npm install --no-save --package-lock=false \\\n      "agent-browser@${AGENT_BROWSER_VERSION}" \\\n';
const npmAfter='    && node -e "const fs=require(\'node:fs\'); const actual=JSON.parse(fs.readFileSync(\'/app/node_modules/agent-browser/package.json\',\'utf8\')).version; if(actual!==process.argv[1]) throw Error(\'LOCKED_AGENT_BROWSER_VERSION_MISMATCH: \'+actual);" "${AGENT_BROWSER_VERSION}" \\\n';
test('local Dockerfile candidate changes only bounded apt retry and redundant unlocked install',()=>{
 const result=shell.createOriginalShellDockerfileCandidate(original);
 const expected=original
  .replace('&& apt-get update && apt-get install -y --no-install-recommends \\', '&& apt-get -o Acquire::Retries=5 update && ( attempt=0; until apt-get install -y --no-install-recommends \\')
  .replace('    locales \\\n    && rm -rf /var/lib/apt/lists/*','    locales; do attempt=$((attempt + 1)); [ "$attempt" -lt 3 ] || exit 100; done ) \\\n    && rm -rf /var/lib/apt/lists/*')
  .replace(npmBefore,npmAfter);
 assert.equal(result.dockerfile,expected);
 assert.equal(result.sourceHash,'fbc6077c10535cbc65e2f7d4815cdf00971be249adcac8dde2f7de8b14e7e61a');
 assert.equal(result.changes.length,3);
 assert.ok(result.dockerfile.includes('RUN npm ci \\\n'));
 assert.ok(result.dockerfile.includes('RUN npm run build \\\n'));
 assert.equal(result.dockerfile.includes('npm install --no-save --package-lock=false'),false);
 assert.throws(()=>shell.createOriginalShellDockerfileCandidate(original+'\n'),/ORIGINAL_SHELL_DOCKERFILE_SOURCE/);
 assert.throws(()=>shell.createOriginalShellDockerfileCandidate(result.dockerfile),/ORIGINAL_SHELL_DOCKERFILE_SOURCE/);
});
