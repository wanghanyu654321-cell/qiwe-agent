import { statSync } from 'node:fs';
import path from 'node:path';
import { applyDirectoryMigration, readSqliteDirectory } from './directory-store.js';
import { FRONT_CLAW_DATABASE_URL, openPerformanceStore, type OpenedPerformanceStore } from './performance-open.js';
import { createWecomBotHandler, type WecomBotHandlerOptions } from './wecom-bot-unified-handler.js';

/** Base SQLite file holding employee bindings and people aliases. Optional. */
export const FRONT_CLAW_SQLITE_PATH = 'FRONT_CLAW_SQLITE_PATH';
export const MAINTENANCE_INTERVAL_MS = 90_000;

export interface FrontClawBoot {
  driver: OpenedPerformanceStore['driver'];
  /** present when this checkout has integrations/native; absent on the current live base. */
  native: 'present' | 'absent';
  store: OpenedPerformanceStore['store'];
  bindings: OpenedPerformanceStore['bindings'];
  handler: ReturnType<typeof createWecomBotHandler>;
  migrated: { bindings: number; aliases: number };
  startMaintenance(): void;
  close(): Promise<void>;
}

/** Feature-detect the optional native overlay. A missing directory does not throw. */
export function nativeIntegrationStatus(root = process.cwd()): 'present' | 'absent' {
  try {
    return statSync(path.join(root, 'integrations', 'native', 'conversation-overlay.mjs')).isFile() ? 'present' : 'absent';
  } catch {
    return 'absent';
  }
}

/**
 * Open the performance store and the unified assistant.
 * Postgres is used only when FRONT_CLAW_DATABASE_URL is set. Otherwise the memory store is the fallback.
 * Existing SQLite bindings and aliases are copied once; a second call does not insert them again.
 */
export async function bootFrontClaw(options: {
  env?: Record<string, string | undefined>;
  now?: () => Date;
  send: WecomBotHandlerOptions['send'];
  model: WecomBotHandlerOptions['model'];
  root?: string;
  maintenanceIntervalMs?: number;
}): Promise<FrontClawBoot> {
  const env = options.env ?? process.env;
  const opened = await openPerformanceStore(env);
  const sqlitePath = env[FRONT_CLAW_SQLITE_PATH]?.trim() ?? '';
  const migrated = sqlitePath
    ? await applyDirectoryMigration({ store: opened.store, bindings: opened.bindings }, readSqliteDirectory(sqlitePath))
    : { bindings: 0, aliases: 0 };
  const handler = createWecomBotHandler({
    mode: 'isolated-synthetic',
    store: opened.store,
    now: options.now ?? (() => new Date()),
    resolve: memberId => opened.store.getPersonByMember(memberId),
    send: options.send,
    model: options.model,
  });
  let timer: ReturnType<typeof setInterval> | undefined;
  return {
    driver: opened.driver,
    native: nativeIntegrationStatus(options.root),
    store: opened.store,
    bindings: opened.bindings,
    handler,
    migrated,
    startMaintenance() {
      if (timer) return;
      const interval = options.maintenanceIntervalMs ?? MAINTENANCE_INTERVAL_MS;
      if (!Number.isInteger(interval) || interval < 1 || interval > 600_000) throw Error('invalid_front_claw_maintenance');
      timer = setInterval(() => { void handler.runMaintenance().catch(() => {}); }, interval);
      timer.unref?.();
    },
    async close() {
      if (timer) clearInterval(timer);
      timer = undefined;
      await opened.close();
    },
  };
}

export { FRONT_CLAW_DATABASE_URL };
