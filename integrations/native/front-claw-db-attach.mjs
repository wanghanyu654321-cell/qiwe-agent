import fs from 'node:fs';

export const FRONT_CLAW_DB_ENV_FILE = '/home/ubuntu/qiwe-private/front-claw-db.env';
export const FRONT_CLAW_DB_NETWORK = 'claw-wecom-business-isolated-20261008-r1';
const ENV_KEY = 'FRONT_CLAW_DATABASE_URL';

function absolutePath(value) {
  if (!value.startsWith('/') || value.includes('\0') || /[\r\n]/.test(value)) throw Error('FRONT_CLAW_DB_ENV_PATH');
  return value;
}

/** Path this process and its Docker CLI can open. Unset keeps the mode-600 default. Never the URL. */
export function frontClawDatabaseEnvFile(env = process.env) {
  const value = typeof env.FRONT_CLAW_DB_ENV_FILE === 'string' ? env.FRONT_CLAW_DB_ENV_FILE.trim() : '';
  return value ? absolutePath(value) : FRONT_CLAW_DB_ENV_FILE;
}

/** Docker network shared with claw-wecom-pg. FRONT_CLAW_DB_NETWORK overrides the default. */
/**
 * Secret-free description of how this repository injects the database.
 * It does not inspect an external shell script. The ledger is opened in the
 * pilot process. Transport appends --env-file for the Docker CLI in this same
 * process. The CLI opens that path; a daemon bind source is a different path.
 */
export function describeFrontClawLaunch(env = process.env) {
  const set = key => typeof env[key] === 'string' && env[key].trim() ? 'set' : 'unset';
  let file = 'absent';
  try {
    const url = loadFrontClawDatabaseEnv(env.FRONT_CLAW_DB_ENV_FILE || FRONT_CLAW_DB_ENV_FILE);
    file = url ? 'present' : 'absent';
  } catch { file = 'unreadable'; }
  return {
    databaseUrl: set('FRONT_CLAW_DATABASE_URL'),
    databaseHost: set('FRONT_CLAW_DATABASE_HOST'),
    envFile: file,
    network: frontClawDbNetwork(env),
    pilotProcessReadsEnvFile: true,
    dockerCliReadsEnvFile: file === 'present',
    envFileOpenedBy: 'docker-cli-client',
    bindSourceOpenedBy: 'daemon',
    ledgerOpenedInPilotProcess: true,
    externalShellInspected: false,
  };
}

/** Files tsc emits. role-eval does not import integrations/native. */
export const CORE_BUILD_INCLUDE = 'src/**/*.ts';
export const CORE_BUILD_OUT_DIR = 'dist';
/**
 * Present only when the process is the controlled-real entry.
 * verify-full-host.mjs spawns that entry solely with --controlled-real-pilot.
 * linux-runtime.mjs runs verify-full-host without that flag and with --network=none.
 */
export const CONTROLLED_REAL_LAUNCH_FILES = [
  'integrations/native/verify-full-host.mjs',
  'integrations/native/frontagent-controlled-live-entry.mjs',
  'integrations/native/frontagent-controlled-live-worker.mjs',
  'integrations/native/frontagent-controlled-pilot.mjs',
  'integrations/native/front-claw-db-attach.mjs',
  'integrations/native/controlled-real-container-transport.mjs',
];

/**
 * What this repository file does with an argv. It does not describe the field
 * tree frontagent-r3-20261029 or start-live-pilot.sh. Those files are not here.
 * verify-full-host.mjs copies frontagent-controlled-live-entry.mjs into a
 * generated test-support directory and spawns that copy. The copy is not a
 * checked-in tree, and the spawn environment in this file does not add the
 * database URL or --env-file.
 */
export function describeRepositoryLaunchPath(argv = []) {
  const controlled = argv.includes('--controlled-real-pilot');
  return {
    argvSelectsControlledRealEntry: controlled,
    spawnedEntry: 'test-support/frontagent-controlled-live-entry.mjs',
    spawnedEntryIsGeneratedCopy: true,
    checkedInTestSupport: false,
    databaseUrlPassedByVerifyFullHost: false,
    openPerformanceStoreDependsOnCopiedEntry: controlled,
    linuxRuntimeDefaultNetwork: 'none',
    coreBuildInclude: CORE_BUILD_INCLUDE,
    coreBuildOutDir: CORE_BUILD_OUT_DIR,
    coreDistDependsOnNative: false,
    controlledRealLaunchFiles: CONTROLLED_REAL_LAUNCH_FILES,
    externalShellInspected: false,
  };
}

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

/**
 * Insert --env-file. This process opens the file first. The Docker CLI then
 * opens the same path in its own process and sends variables to the daemon.
 * The path is not a bind-mount source. The secret is not copied into argv.
 */
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
