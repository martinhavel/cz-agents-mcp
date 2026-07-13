import { describe, expect, it } from 'vitest';

class ReinsertOnSetMap extends Map<string, number[]> {
  private visits = 0;

  override set(ip: string, times: number[]): this {
    this.delete(ip);
    return super.set(ip, times);
  }

  override *[Symbol.iterator](): MapIterator<[string, number[]]> {
    for (const entry of super[Symbol.iterator]()) {
      this.visits += 1;
      if (this.visits > this.size + 1) throw new Error('live iteration revisited a reinserted key');
      yield entry;
    }
  }
}

describe('cleanupSessionTimes', () => {
  it('caps the number of tracked session IPs', async () => {
    process.env.SANDBOX_HMAC_SECRET = 'test-secret';
    const { cleanupSessionTimes, MAX_SESSION_IPS } = await import('../http.js');
    const sessionTimes = new Map<string, number[]>();
    const now = Date.now();
    for (let i = 0; i <= MAX_SESSION_IPS; i += 1) {
      sessionTimes.set(`ip-${i}`, [now + i]);
    }

    cleanupSessionTimes(sessionTimes);

    expect(sessionTimes.size).toBeLessThanOrEqual(MAX_SESSION_IPS);
    expect(sessionTimes.has('ip-0')).toBe(false);
    expect(sessionTimes.has(`ip-${MAX_SESSION_IPS}`)).toBe(true);
  }, 20_000);

  it('terminates when set() reinserts entries during cleanup', async () => {
    process.env.SANDBOX_HMAC_SECRET = 'test-secret';
    const { cleanupSessionTimes } = await import('../http.js');
    const sessionTimes = new ReinsertOnSetMap();
    sessionTimes.set('ip-1', [Date.now()]);

    expect(() => cleanupSessionTimes(sessionTimes)).not.toThrow();
    expect(sessionTimes.size).toBe(1);
  }, 20_000);
});
