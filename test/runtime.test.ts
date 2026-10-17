import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { readEnv, webCrypto } from '../src/runtime';
import { USER_AGENT, VERSION } from '../src/version';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe('webCrypto', () => {
  it('uses globalThis.crypto', async () => {
    expect(await webCrypto()).toBe(globalThis.crypto);
  });

  it('falls back to node:crypto webcrypto when there is no global (Node 18), once', async () => {
    vi.stubGlobal('crypto', undefined);
    const { webCrypto: fresh } = await import('../src/runtime');
    const nodeWeb = (await import('node:crypto')).webcrypto;
    const a = fresh();
    expect(fresh()).toBe(a);
    expect(await a).toBe(nodeWeb);
  });
});

describe('readEnv', () => {
  it('reads process.env, trimmed; empty is undefined', () => {
    vi.stubEnv('AVACAST_T', ' v ');
    expect(readEnv('AVACAST_T')).toBe('v');
    vi.stubEnv('AVACAST_T', '  ');
    expect(readEnv('AVACAST_T')).toBeUndefined();
    expect(readEnv('AVACAST_NOT_SET')).toBeUndefined();
  });

  it('reads Deno.env when there is no process', () => {
    vi.stubGlobal('process', undefined);
    vi.stubGlobal('Deno', { env: { get: (n: string) => (n === 'K' ? 'deno' : undefined) } });
    expect(readEnv('K')).toBe('deno');
    expect(readEnv('X')).toBeUndefined();
  });

  it('returns undefined when Deno denies env access, or neither exists', () => {
    vi.stubGlobal('process', { env: undefined });
    vi.stubGlobal('Deno', {
      env: {
        get() {
          throw new Error('PermissionDenied');
        },
      },
    });
    expect(readEnv('K')).toBeUndefined();
    vi.stubGlobal('Deno', undefined);
    expect(readEnv('K')).toBeUndefined();
  });
});

describe('version', () => {
  it('equals package.json and is in the User-Agent', () => {
    const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as {
      version: string;
    };
    expect(VERSION).toBe(pkg.version);
    expect(USER_AGENT).toBe(`avacast-node/${pkg.version}`);
  });

  it('CHANGELOG has an entry for this version', () => {
    const log = readFileSync(new URL('../CHANGELOG.md', import.meta.url), 'utf8');
    expect(log).toContain(`## ${VERSION}`);
  });
});

describe('uuid', () => {
  it('is a random v4 UUID', async () => {
    const { uuid } = await import('../src/runtime');
    const a = await uuid();
    expect(a).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(await uuid()).not.toBe(a);
  });
});
