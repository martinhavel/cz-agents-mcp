import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { TtlMap } from '../cache.js';
import {
  clearRequestIp,
  cleanup,
  getCurrentSessionId,
  logToolCall,
  registerSession,
  resolveClientIp,
  resolveClientUa,
  runWithIp,
  setRequestIp,
  setRequestUa,
  wrapServerTools,
} from '../icoTracker.js';

describe('client IP attribution', () => {
  afterEach(() => {
    clearRequestIp();
    delete process.env.TOOL_EVENTS_DIR;
    delete process.env.TOOL_EVENTS_FULL_IP;
    delete process.env.TOOL_EVENTS_RETENTION_DAYS;
    vi.restoreAllMocks();
  });

  it('registerSession + resolveClientIp prefer session IP over ALS and fallback IP', async () => {
    setRequestIp('198.51.100.20');
    registerSession('session-a', '203.0.113.10');

    await runWithIp('192.0.2.30', async () => {
      expect(resolveClientIp('session-a')).toBe('203.0.113.10');
      expect(resolveClientIp()).toBe('192.0.2.30');
    });
  });

  it('registerSession ignores empty session or IP values', () => {
    setRequestIp('198.51.100.21');

    registerSession('', '203.0.113.11');
    registerSession('session-empty-ip', '');

    expect(resolveClientIp('')).toBe('198.51.100.21');
    expect(resolveClientIp('session-empty-ip')).toBe('198.51.100.21');
  });

  it('wrapServerTools runs the handler in the resolved session IP scope', async () => {
    registerSession('session-wrap', '203.0.113.12');
    let observedIp = '';
    let observedSessionId = '';
    const registeredTools: unknown[][] = [];
    const server = {
      tool: (...args: unknown[]) => {
        registeredTools.push(args);
        return { ok: true };
      },
    };

    wrapServerTools(server);
    server.tool('tool_name', {}, async (_args: unknown, _extra: unknown) => {
      observedIp = resolveClientIp();
      observedSessionId = getCurrentSessionId() ?? '';
    });

    const handler = registeredTools[0]?.at(-1);
    expect(typeof handler).toBe('function');
    await (handler as (args: unknown, extra: { sessionId: string }) => Promise<void>)(
      {},
      { sessionId: 'session-wrap' },
    );

    expect(observedIp).toBe('203.0.113.12');
    expect(observedSessionId).toBe('session-wrap');
  });

  it('TtlMap evicts oldest entries when bounded', () => {
    const map = new TtlMap<string, string>({
      ttlMs: 60_000,
      maxSize: 2,
      sweepIntervalMs: false,
    });

    map.set('session-a', '203.0.113.1');
    map.set('session-b', '203.0.113.2');
    map.set('session-c', '203.0.113.3');

    expect(map.get('session-a')).toBeUndefined();
    expect(map.get('session-b')).toBe('203.0.113.2');
    expect(map.get('session-c')).toBe('203.0.113.3');
  });
});

describe('tool event JSONL persistence', () => {
  let tempDirs: string[] = [];

  afterEach(async () => {
    clearRequestIp();
    delete process.env.TOOL_EVENTS_DIR;
    delete process.env.TOOL_EVENTS_FULL_IP;
    delete process.env.TOOL_EVENTS_RETENTION_DAYS;
    vi.restoreAllMocks();
    await Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true })));
    tempDirs = [];
  });

  it('writes one JSONL line to the UTC daily file', async () => {
    const dir = await tempToolEventsDir();
    vi.spyOn(console, 'error').mockImplementation(() => {});
    process.env.TOOL_EVENTS_DIR = dir;
    setRequestIp('203.0.113.44');

    logToolCall('ares', 'get_company', { ico: '27074358', limit: 2 });

    const record = await readOnlyRecord(dir);
    expect(record).toMatchObject({
      service: 'ares',
      tool: 'get_company',
      status: 'ok',
      ip_prefix: '203.0.113',
      param_keys: ['ico', 'limit'],
      ico: '27074358',
      limit: '2',
    });
    expect(typeof record.ts).toBe('string');
  });

  it('records the client UA so catalog scanners are separable from real clients', async () => {
    const dir = await tempToolEventsDir();
    vi.spyOn(console, 'error').mockImplementation(() => {});
    process.env.TOOL_EVENTS_DIR = dir;

    // Session carries the UA (registered at session init, like the IP).
    registerSession('sess-scanner', '203.0.113.90', 'SentinelOracle/0.1 (+https://glimind.com/opt-out)');
    await runWithIp('203.0.113.90', async () => {
      // resolveClientUa prefers the session UA — this is what the tool scope uses.
      expect(resolveClientUa('sess-scanner')).toContain('SentinelOracle');
    });

    setRequestUa('Claude-User (claude-code/2.1.201)');
    setRequestIp('203.0.113.91');
    logToolCall('ares', 'lookup_by_ico', { ico: '27074358' });

    const record = await readOnlyRecord(dir);
    expect(record.ua).toBe('Claude-User (claude-code/2.1.201)');
    expect(record.ip_prefix).toBe('203.0.113');
  });

  it('omits ua when the client sent none (older callers stay valid)', async () => {
    const dir = await tempToolEventsDir();
    vi.spyOn(console, 'error').mockImplementation(() => {});
    process.env.TOOL_EVENTS_DIR = dir;
    setRequestIp('203.0.113.92');

    logToolCall('cnb', 'get_rates', {});

    const record = await readOnlyRecord(dir);
    expect('ua' in record).toBe(false);
  });

  it('keeps the depth enum value (basic/full), not only numeric params', async () => {
    const dir = await tempToolEventsDir();
    vi.spyOn(console, 'error').mockImplementation(() => {});
    process.env.TOOL_EVENTS_DIR = dir;
    setRequestIp('203.0.113.46');

    logToolCall('dd', 'get_dd_report', { ico: '27074358', depth: 'full' });

    const record = await readOnlyRecord(dir);
    expect(record).toMatchObject({
      service: 'dd',
      tool: 'get_dd_report',
      ico: '27074358',
      depth: 'full',
    });
    expect((record.param_keys as string[]).slice().sort()).toEqual(['depth', 'ico']);
  });

  it('preserves redaction in JSONL and does not write names, addresses, or free-text query args', async () => {
    const dir = await tempToolEventsDir();
    vi.spyOn(console, 'error').mockImplementation(() => {});
    process.env.TOOL_EVENTS_DIR = dir;
    setRequestIp('203.0.113.45');

    logToolCall('ares', 'search_companies', {
      query: 'Rentio person name',
      city: 'Praha',
      street: 'Dlouha 123',
      name: 'Jane Doe',
      address: 'Dlouha 123, Praha',
      ico: '27074358',
    });

    const raw = await readOnlyRawLine(dir);
    expect(raw).toContain('"ico":"27074358"');
    expect(raw).toContain('"param_keys"');
    expect(raw).not.toContain('Rentio');
    expect(raw).not.toContain('Praha');
    expect(raw).not.toContain('Dlouha');
    expect(raw).not.toContain('Jane');
  });

  it('uses ip_prefix by default and full ip only when TOOL_EVENTS_FULL_IP=1', async () => {
    const dir = await tempToolEventsDir();
    vi.spyOn(console, 'error').mockImplementation(() => {});
    process.env.TOOL_EVENTS_DIR = dir;

    setRequestIp('198.51.100.9');
    logToolCall('ares', 'get_company', { ico: '27074358' });
    let record = await readOnlyRecord(dir);
    expect(record.ip_prefix).toBe('198.51.100');

    await rm(join(dir, `tool-events-${new Date().toISOString().slice(0, 10)}.jsonl`), {
      force: true,
    });
    process.env.TOOL_EVENTS_FULL_IP = '1';
    logToolCall('ares', 'get_company', { ico: '27074358' });
    record = await readOnlyRecord(dir);
    expect(record.ip_prefix).toBe('198.51.100.9');
  });

  it('does not throw and creates no file when TOOL_EVENTS_DIR is unset', async () => {
    const dir = await tempToolEventsDir();
    vi.spyOn(console, 'error').mockImplementation(() => {});
    setRequestIp('203.0.113.46');

    expect(() => logToolCall('ares', 'get_company', { ico: '27074358' })).not.toThrow();
    expect(await readdir(dir)).toEqual([]);
  });

  it('prunes old tool event files during cleanup', async () => {
    const dir = await tempToolEventsDir();
    process.env.TOOL_EVENTS_DIR = dir;
    process.env.TOOL_EVENTS_RETENTION_DAYS = '90';
    const oldFile = join(dir, 'tool-events-2000-01-01.jsonl');
    const keepFile = join(dir, `tool-events-${new Date().toISOString().slice(0, 10)}.jsonl`);
    await writeFile(oldFile, '{}\n', 'utf8');
    await writeFile(keepFile, '{}\n', 'utf8');

    cleanup();

    await waitFor(async () => !(await fileExists(oldFile)));
    expect(await fileExists(keepFile)).toBe(true);
  });

  async function tempToolEventsDir(): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), 'czagents-tool-events-'));
    tempDirs.push(dir);
    return dir;
  }
});

describe('daily cap buckets', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it('keeps entity cap independent from query units', async () => {
    const tracker = await importTrackerWithCaps({ ico: 60, query: 0 });

    await tracker.runWithIp('203.0.113.10', async () => {
      for (let i = 0; i < 59; i += 1) tracker.trackQuery(`id:gb:${i}`);
      for (let i = 0; i < 100; i += 1) tracker.trackQuery(`q:${i.toString().padStart(16, '0')}`);
      expect(tracker.dailyCapExceeded()).toBe(false);
      tracker.trackQuery('id:gb:59');
      expect(tracker.dailyCapExceeded()).toBe('entity');
    });
  });

  it('blocks query cap only for q-prefixed keys', async () => {
    const tracker = await importTrackerWithCaps({ ico: 0, query: 2 });

    await tracker.runWithIp('203.0.113.20', async () => {
      tracker.trackQuery('27074358');
      tracker.trackQuery('id:gb:14356670');
      tracker.trackQuery('id:de:W38RGI023J3WT1HWRP32');
      expect(tracker.dailyCapExceeded()).toBe(false);
      tracker.trackQuery('q:0000000000000001');
      expect(tracker.dailyCapExceeded()).toBe(false);
      tracker.trackQuery('q:0000000000000002');
      expect(tracker.dailyCapExceeded()).toBe('query');
    });
  });

  it('unions entity units across the same IPv4 /24', async () => {
    const tracker = await importTrackerWithCaps({ ico: 2, query: 0 });

    await tracker.runWithIp('198.51.100.10', async () => {
      tracker.trackQuery('id:gb:one');
      expect(tracker.dailyCapExceeded()).toBe(false);
    });
    await tracker.runWithIp('198.51.100.200', async () => {
      tracker.trackQuery('id:gb:two');
      expect(tracker.dailyCapExceeded()).toBe('entity');
    });
  });

  it('counts the same normalized query once and excludes pagination fields', async () => {
    const tracker = await importTrackerWithCaps({ ico: 0, query: 2 });

    await tracker.runWithIp('192.0.2.50', async () => {
      tracker.trackQuery(tracker.queryUnitKey({ query: '  Acme  ', city: 'Praha', pocet: 10, start: 0 }));
      tracker.trackQuery(tracker.queryUnitKey({ query: 'acme', city: ' Praha ', pocet: 100, start: 50 }));
      expect(tracker.dailyCapExceeded()).toBe(false);
      tracker.trackQuery(tracker.queryUnitKey({ query: 'Beta', city: 'Praha', pocet: 10, start: 0 }));
      expect(tracker.dailyCapExceeded()).toBe('query');
    });
  });
});

async function readOnlyRecord(dir: string): Promise<Record<string, unknown>> {
  return JSON.parse(await readOnlyRawLine(dir)) as Record<string, unknown>;
}

async function readOnlyRawLine(dir: string): Promise<string> {
  const file = join(dir, `tool-events-${new Date().toISOString().slice(0, 10)}.jsonl`);
  await waitFor(async () => fileExists(file));
  const raw = await readFile(file, 'utf8');
  const lines = raw.trim().split('\n');
  expect(lines).toHaveLength(1);
  return lines[0] ?? '';
}

async function importTrackerWithCaps(caps: { ico: number; query: number }) {
  vi.resetModules();
  vi.stubEnv('LOOKUP_HASH_SALT', 'test-salt');
  vi.stubEnv('ICO_DAILY_CAP', String(caps.ico));
  vi.stubEnv('QUERY_DAILY_CAP', String(caps.query));
  return import('../icoTracker.js');
}

async function fileExists(file: string): Promise<boolean> {
  try {
    await readFile(file, 'utf8');
    return true;
  } catch {
    return false;
  }
}

async function waitFor(predicate: () => Promise<boolean>, timeoutMs = 1000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('Timed out waiting for async file operation');
}
