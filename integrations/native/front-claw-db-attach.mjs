import fs from 'node:fs';

export const FRONT_CLAW_DB_ENV_FILE = '/home/ubuntu/qiwe-private/front-claw-db.env';
export const FRONT_CLAW_DB_NETWORK = 'claw-wecom-business-isolated-20261008-r1';
const ENV_KEY = 'FRONT_CLAW_DATABASE_URL';

/** Docker network shared with claw-wecom-pg. FRONT_CLAW_DB_NETWORK overrides the default. */
export function frontClawDbNetwork(env = process.env) {
  const value = typeof env.FRONT_CLAW_DB_NETWORK === 'string' ? env.FRONT_CLAW_DB_NETWORK.trim() : '';
  if (!value) return FRONT_CLAW_DB_NETWORK;
  if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(value)) throw Error('FRONT_CLAW_DB_NETWORK_INVALID');
  return value;
}

function reject(code) { throw Error(code); }

/** Read the private env file. The returned URL must not be logged. */
export function loadFrontClawDatabaseEnv(file = FRONT_CLAW_DB_ENV_FILE) {
  let fd;
  try { fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW); }
  catch (error) { if (error?.code === 'ENOENT') return null; reject('FRONT_CLAW_DB_ENV_UNREADABLE'); }
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.nlink !== 1 || (stat.mode & 0o077) !== 0 || stat.size > 4096) reject('FRONT_CLAW_DB_ENV_UNREADABLE');
    const text = fs.readFileSync(fd, 'utf8');
    let url = '';
    for (const line of text.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const eq = trimmed.indexOf('=');
      if (eq < 1) reject('FRONT_CLAW_DB_ENV_INVALID');
      const key = trimmed.slice(0, eq).trim();
      let value = trimmed.slice(eq + 1).trim();
      if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
      if (key !== ENV_KEY || !value || /[\r\n\u0000]/.test(value)) reject('FRONT_CLAW_DB_ENV_INVALID');
      if (url) reject('FRONT_CLAW_DB_ENV_INVALID');
      url = value;
    }
    if (!url) reject('FRONT_CLAW_DB_ENV_INVALID');
    return url;
  } finally { if (fd !== undefined) fs.closeSync(fd); }
}

/** Insert --env-file. The secret stays in the file and is not copied into argv. */
export function withDatabaseEnvFile(args, file = FRONT_CLAW_DB_ENV_FILE) {
  if (!Array.isArray(args) || args.includes('--env-file')) reject('FRONT_CLAW_DB_LAUNCH_ARGS');
  if (!loadFrontClawDatabaseEnv(file)) return [...args];
  const next = [...args];
  const image = next.findIndex(arg => arg === '--entrypoint=node' || arg === '--entrypoint');
  const at = image > 0 ? image : next.length;
  next.splice(at, 0, '--env-file', file);
  return next;
}

export function connectRunnerDatabaseNetwork({ invoke, runner, network = frontClawDbNetwork() }) {
  if (typeof invoke !== 'function' || typeof runner !== 'string' || !runner || /[\r\n\u0000]/.test(runner)) reject('FRONT_CLAW_DB_RUNNER');
  invoke(['network', 'connect', network, runner]);
}

export function disconnectRunnerDatabaseNetwork({ invoke, runner, network = frontClawDbNetwork() }) {
  if (typeof invoke !== 'function' || typeof runner !== 'string' || !runner || /[\r\n\u0000]/.test(runner)) reject('FRONT_CLAW_DB_RUNNER');
  invoke(['network', 'disconnect', network, runner]);
}
