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
  runWithIp,
  setRequestIp,
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
