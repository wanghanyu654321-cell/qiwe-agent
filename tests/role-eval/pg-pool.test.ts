import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import { resolvePgPool } from '../../src/role-eval/pg-pool.js';
import { applyDatabaseHost, FRONT_CLAW_DATABASE_HOST } from '../../src/role-eval/performance-open.js';

it('resolves Pool from the ESM default export and from the CJS require export', async () => {
  const imported = await import('pg');
  expect(typeof resolvePgPool(imported)).toBe('function');
  const required = createRequire(import.meta.url)('pg') as { Pool?: unknown; default?: unknown };
  expect(required.default).toBeUndefined();
  expect(typeof required.Pool).toBe('function');
  expect(resolvePgPool(required)).toBe(required.Pool);
  const named = function Pool() { return undefined; };
  expect(typeof resolvePgPool({ Pool: named })).toBe('function');
  expect(typeof resolvePgPool({ default: { default: { Pool: named } } })).toBe('function');
  expect(resolvePgPool({})).toBeUndefined();
  expect(resolvePgPool(null)).toBeUndefined();
});

it('replaces only the database host and does not keep a password in source', () => {
  const secret = 'not-a-logged-password';
  const next = applyDatabaseHost(`postgres://frontclaw:${secret}@127.0.0.1:5432/postgres`, 'claw-wecom-pg');
  const parsed = new URL(next);
  expect(parsed.hostname).toBe('claw-wecom-pg');
  expect(parsed.password).toBe(secret);
  expect(parsed.port).toBe('5432');
  expect(() => applyDatabaseHost('postgres://frontclaw:pw@127.0.0.1/postgres', 'bad host')).toThrow('FRONT_CLAW_DATABASE_UNAVAILABLE_HOST');
  const opener = readFileSync(new URL('../../src/role-eval/performance-open.ts', import.meta.url), 'utf8');
  expect(opener).toContain(FRONT_CLAW_DATABASE_HOST);
  expect(opener).not.toMatch(/postgres:\/\/\w+:[^@\s]+@/);
  const assembly = readFileSync(new URL('../../src/role-eval/wecom-bot-assembly.ts', import.meta.url), 'utf8');
  const pilot = readFileSync(new URL('../../src/role-eval/wecom-bot-pilot.ts', import.meta.url), 'utf8');
  const boot = readFileSync(new URL('../../src/role-eval/front-claw-boot.ts', import.meta.url), 'utf8');
  for (const source of [assembly, pilot, boot]) {
    expect(source).not.toMatch(/from ['"][^'"]*integrations\/native/);
    expect(source).not.toMatch(/import\([^)]*integrations\/native/);
  }
  expect(pilot).toContain('bootFrontClaw');
  expect(boot).toContain('nativeIntegrationStatus');
});
