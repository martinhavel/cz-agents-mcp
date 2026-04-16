import { describe, it, expect, vi } from 'vitest';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { createRateLimiter, checkBodySize } from '../rateLimit.js';

function mockReq(opts: {
  headers?: Record<string, string | string[] | undefined>;
  remoteAddress?: string;
} = {}): IncomingMessage {
  return {
    headers: opts.headers ?? {},
    socket: { remoteAddress: opts.remoteAddress ?? '1.2.3.4' },
  } as unknown as IncomingMessage;
}

function mockRes() {
  const headers: Record<string, string> = {};
  let statusCode = 200;
  let body = '';
  const res = {
    setHeader: vi.fn((k: string, v: string) => { headers[k.toLowerCase()] = v; }),
    writeHead: vi.fn((code: number, hdrs?: Record<string, string>) => {
      statusCode = code;
      if (hdrs) for (const [k, v] of Object.entries(hdrs)) headers[k.toLowerCase()] = v;
    }),
    end: vi.fn((data?: string) => { if (data) body = data; }),
  } as unknown as ServerResponse;
  return { res, headers, getStatus: () => statusCode, getBody: () => body };
}

describe('createRateLimiter', () => {
  it('allows requests under the limit', () => {
    const check = createRateLimiter({ windowMs: 60_000, max: 3 });
    const req = mockReq({ remoteAddress: '10.0.0.1' });
    const { res, headers } = mockRes();

    expect(check(req, res)).toBe(true);
    expect(check(req, res)).toBe(true);
    expect(check(req, res)).toBe(true);
    expect(headers['x-ratelimit-limit']).toBe('3');
    expect(headers['x-ratelimit-remaining']).toBe('0');
  });

  it('blocks the (max+1)-th request with 429', () => {
    const check = createRateLimiter({ windowMs: 60_000, max: 2 });
    const req = mockReq({ remoteAddress: '10.0.0.2' });
    const r1 = mockRes();
    expect(check(req, r1.res)).toBe(true);
    expect(check(req, r1.res)).toBe(true);

    const r2 = mockRes();
    expect(check(req, r2.res)).toBe(false);
    expect(r2.getStatus()).toBe(429);
    const parsed = JSON.parse(r2.getBody());
    expect(parsed.error).toBe('rate_limit_exceeded');
    expect(parsed.retry_after_seconds).toBeGreaterThan(0);
  });

  it('tracks different IPs separately', () => {
    const check = createRateLimiter({ windowMs: 60_000, max: 1 });
    const reqA = mockReq({ remoteAddress: '10.0.0.3' });
    const reqB = mockReq({ remoteAddress: '10.0.0.4' });

    expect(check(reqA, mockRes().res)).toBe(true);
    expect(check(reqA, mockRes().res)).toBe(false); // A over
    expect(check(reqB, mockRes().res)).toBe(true);  // B fresh
  });

  it('resets the bucket after windowMs elapses', () => {
    vi.useFakeTimers();
    try {
      const check = createRateLimiter({ windowMs: 1000, max: 1 });
      const req = mockReq({ remoteAddress: '10.0.0.5' });

      expect(check(req, mockRes().res)).toBe(true);
      expect(check(req, mockRes().res)).toBe(false);
      vi.advanceTimersByTime(1001);
      expect(check(req, mockRes().res)).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('prefers CF-Connecting-IP over socket address', () => {
    const check = createRateLimiter({ max: 1 });
    const reqCfA = mockReq({
      headers: { 'cf-connecting-ip': '203.0.113.1' },
      remoteAddress: '10.0.0.99',
    });
    const reqCfB = mockReq({
      headers: { 'cf-connecting-ip': '203.0.113.2' },
      remoteAddress: '10.0.0.99', // same socket, different CF IP
    });

    expect(check(reqCfA, mockRes().res)).toBe(true);
    expect(check(reqCfB, mockRes().res)).toBe(true); // different bucket
    expect(check(reqCfA, mockRes().res)).toBe(false); // A's bucket full
  });

  it('uses first entry of X-Forwarded-For', () => {
    const check = createRateLimiter({ max: 1 });
    const req = mockReq({
      headers: { 'x-forwarded-for': '203.0.113.5, 10.0.0.1' },
    });
    expect(check(req, mockRes().res)).toBe(true);
    expect(check(req, mockRes().res)).toBe(false);
  });

  it('supports custom getIp', () => {
    const check = createRateLimiter({ max: 1, getIp: () => 'fixed' });
    expect(check(mockReq({ remoteAddress: 'a' }), mockRes().res)).toBe(true);
    expect(check(mockReq({ remoteAddress: 'b' }), mockRes().res)).toBe(false);
  });
});

describe('checkBodySize', () => {
  it('allows requests under maxBytes', () => {
    const req = mockReq({ headers: { 'content-length': '500' } });
    const { res } = mockRes();
    expect(checkBodySize(req, res, 1000)).toBe(true);
  });

  it('rejects oversized requests with 413', () => {
    const req = mockReq({ headers: { 'content-length': '2000' } });
    const { res, getStatus, getBody } = mockRes();
    expect(checkBodySize(req, res, 1000)).toBe(false);
    expect(getStatus()).toBe(413);
    expect(JSON.parse(getBody()).error).toBe('payload_too_large');
  });

  it('allows when content-length header is missing', () => {
    const req = mockReq({ headers: {} });
    const { res } = mockRes();
    expect(checkBodySize(req, res, 100)).toBe(true);
  });

  it('allows when content-length is non-numeric', () => {
    const req = mockReq({ headers: { 'content-length': 'abc' } });
    const { res } = mockRes();
    expect(checkBodySize(req, res, 100)).toBe(true);
  });
});
