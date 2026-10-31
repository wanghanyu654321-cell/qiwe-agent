import {spawnSync} from 'node:child_process';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const vitest = path.join(root, 'node_modules', 'vitest', 'vitest.mjs');
const result = spawnSync(process.execPath, [vitest, 'run', 'tests/offline-wecom-sim.test.ts', 'tests/offline-wecom-sim-pr30-gaps.test.ts'], {cwd: root, stdio: 'inherit'});
process.exit(result.status === null ? 1 : result.status);
