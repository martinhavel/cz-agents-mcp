import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { TtlCache } from '../cache.js';

describe('TtlCache', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('stores and retrieves values', () => {
    const c = new TtlCache<string, number>({ ttlMs: 1000 });
    c.set('a', 1);
    expect(c.get('a')).toBe(1);
  });

  it('expires after TTL', () => {
    const c = new TtlCache<string, number>({ ttlMs: 1000 });
    c.set('a', 1);
    vi.advanceTimersByTime(1001);
    expect(c.get('a')).toBeUndefined();
  });

  it('evicts oldest when maxSize reached (LRU-ish)', () => {
    const c = new TtlCache<string, number>({ ttlMs: 10_000, maxSize: 2 });
    c.set('a', 1);
    c.set('b', 2);
    c.set('c', 3); // evicts 'a'
    expect(c.get('a')).toBeUndefined();
    expect(c.get('b')).toBe(2);
    expect(c.get('c')).toBe(3);
  });

  it('get() refreshes LRU position', () => {
    const c = new TtlCache<string, number>({ ttlMs: 10_000, maxSize: 2 });
    c.set('a', 1);
    c.set('b', 2);
    c.get('a'); // touch → b becomes oldest
    c.set('c', 3); // evicts 'b', not 'a'
    expect(c.get('a')).toBe(1);
    expect(c.get('b')).toBeUndefined();
    expect(c.get('c')).toBe(3);
  });

  it('memoize runs loader once and caches result', async () => {
    const c = new TtlCache<string, string>({ ttlMs: 1000 });
    let calls = 0;
    const loader = async () => { calls++; return 'data'; };
    expect(await c.memoize('k', loader)).toBe('data');
    expect(await c.memoize('k', loader)).toBe('data');
    expect(calls).toBe(1);
  });

  it('clear() empties the cache', () => {
    const c = new TtlCache<string, number>({ ttlMs: 1000 });
    c.set('a', 1);
    c.set('b', 2);
    c.clear();
    expect(c.size).toBe(0);
    expect(c.get('a')).toBeUndefined();
  });
});
