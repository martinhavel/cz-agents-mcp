import { describe, expect, it } from 'vitest';
import type { IncomingMessage } from 'node:http';

function req(headers: Record<string, string>, remote = '203.0.113.9'): IncomingMessage {
  return {
    headers,
    socket: { remoteAddress: remote },
  } as unknown as IncomingMessage;
}

describe('getSandboxIp', () => {
  it('uses the LAST X-Forwarded-For entry (spoof-safe behind apache/CF)', async () => {
    process.env.SANDBOX_HMAC_SECRET = 'test-secret';
    const { getSandboxIp } = await import('../sandbox.js');
    // Client supplies a spoofed first hop; the real IP is appended last by the proxy.
    const ip = getSandboxIp(req({ 'x-forwarded-for': '1.2.3.4, 198.51.100.7' }));
    expect(ip).toBe('198.51.100.7');
  });

  it('ignores cf-connecting-ip (broken "%a" in this topology)', async () => {
    process.env.SANDBOX_HMAC_SECRET = 'test-secret';
    const { getSandboxIp } = await import('../sandbox.js');
    const ip = getSandboxIp(req({ 'cf-connecting-ip': '%a', 'x-forwarded-for': '198.51.100.7' }));
    expect(ip).toBe('198.51.100.7');
  });

  it('buckets IPv6 on /64 prefix', async () => {
    process.env.SANDBOX_HMAC_SECRET = 'test-secret';
    const { getSandboxIp } = await import('../sandbox.js');
    const ip = getSandboxIp(req({ 'x-forwarded-for': '2001:db8:abcd:1234:5678:9abc:def0:1' }));
    expect(ip).toBe('2001:db8:abcd:1234::/64');
  });

  it('falls back to socket remoteAddress when no XFF', async () => {
    process.env.SANDBOX_HMAC_SECRET = 'test-secret';
    const { getSandboxIp } = await import('../sandbox.js');
    expect(getSandboxIp(req({}, '203.0.113.42'))).toBe('203.0.113.42');
  });
});
