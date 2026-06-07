import { afterEach, describe, expect, it } from 'vitest';
import { TtlMap } from '../cache.js';
import {
  clearRequestIp,
  registerSession,
  resolveClientIp,
  runWithIp,
  setRequestIp,
  wrapServerTools,
} from '../icoTracker.js';

describe('client IP attribution', () => {
  afterEach(() => {
    clearRequestIp();
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
    });

    const handler = registeredTools[0]?.at(-1);
    expect(typeof handler).toBe('function');
    await (handler as (args: unknown, extra: { sessionId: string }) => Promise<void>)(
      {},
      { sessionId: 'session-wrap' },
    );

    expect(observedIp).toBe('203.0.113.12');
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
