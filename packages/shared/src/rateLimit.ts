import type { IncomingMessage, ServerResponse } from 'node:http';

/**
 * In-memory per-IP rate limiter — token bucket with fixed window.
 * No external deps (no Redis), scales to thousands of IPs easily.
 *
 * Defaults:
 *   - 60 requests per 60 s per IP (Claude Desktop session makes ~3-10 calls per user turn)
 *   - Cleans up expired buckets every 2 minutes
 *
 * Returns true if request allowed, false if rate limited (writes 429 response).
 */
export interface RateLimiterOptions {
  windowMs?: number;
  max?: number;
  /** Custom IP extractor — useful when behind CF/Apache */
  getIp?: (req: IncomingMessage) => string;
}

interface Bucket {
  count: number;
  resetAt: number;
}

export function createRateLimiter(opts: RateLimiterOptions = {}) {
  const windowMs = opts.windowMs ?? 60_000;
  const max = opts.max ?? 60;
  const getIp = opts.getIp ?? defaultGetIp;
  const buckets = new Map<string, Bucket>();

  // Periodic cleanup of expired buckets (prevent memory leak under churn)
  const cleanup = setInterval(() => {
    const now = Date.now();
    for (const [ip, b] of buckets) {
      if (b.resetAt < now) buckets.delete(ip);
    }
  }, 120_000);
  cleanup.unref(); // don't block process exit

  return function check(req: IncomingMessage, res: ServerResponse): boolean {
    const ip = getIp(req);
    const now = Date.now();
    let bucket = buckets.get(ip);

    if (!bucket || bucket.resetAt < now) {
      bucket = { count: 1, resetAt: now + windowMs };
      buckets.set(ip, bucket);
      res.setHeader('X-RateLimit-Limit', String(max));
      res.setHeader('X-RateLimit-Remaining', String(max - 1));
      res.setHeader('X-RateLimit-Reset', String(Math.floor(bucket.resetAt / 1000)));
      return true;
    }

    if (bucket.count >= max) {
      const retryAfter = Math.ceil((bucket.resetAt - now) / 1000);
      res.writeHead(429, {
        'Content-Type': 'application/json',
        'Retry-After': String(retryAfter),
        'X-RateLimit-Limit': String(max),
        'X-RateLimit-Remaining': '0',
        'X-RateLimit-Reset': String(Math.floor(bucket.resetAt / 1000)),
      });
      res.end(
        JSON.stringify({
          error: 'rate_limit_exceeded',
          message: `Too many requests. Retry after ${retryAfter}s. Higher limits at https://cz-agents.dev/pricing`,
          retry_after_seconds: retryAfter,
          upgrade_url: 'https://cz-agents.dev/pricing?utm_source=mcp&utm_medium=ratelimit',
        }),
      );
      return false;
    }

    bucket.count++;
    res.setHeader('X-RateLimit-Limit', String(max));
    res.setHeader('X-RateLimit-Remaining', String(max - bucket.count));
    res.setHeader('X-RateLimit-Reset', String(Math.floor(bucket.resetAt / 1000)));
    return true;
  };
}

/**
 * Extract client IP, preferring Cloudflare/Apache proxy headers.
 * Checks (in order): CF-Connecting-IP, X-Forwarded-For, X-Real-IP, socket.
 */
function defaultGetIp(req: IncomingMessage): string {
  const cf = req.headers['cf-connecting-ip'];
  if (typeof cf === 'string' && cf.length > 0) return cf;
  const xff = req.headers['x-forwarded-for'];
  if (typeof xff === 'string' && xff.length > 0) {
    const first = xff.split(',')[0]?.trim();
    if (first) return first;
  }
  const xr = req.headers['x-real-ip'];
  if (typeof xr === 'string' && xr.length > 0) return xr;
  return req.socket.remoteAddress ?? 'unknown';
}

/**
 * Body size limit — reject requests larger than `maxBytes`.
 * MCP requests are small (<10 KB), default 100 KB is generous.
 */
export function checkBodySize(req: IncomingMessage, res: ServerResponse, maxBytes = 100_000): boolean {
  const len = req.headers['content-length'];
  if (typeof len === 'string') {
    const n = Number(len);
    if (!isNaN(n) && n > maxBytes) {
      res.writeHead(413, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'payload_too_large', max_bytes: maxBytes }));
      return false;
    }
  }
  return true;
}
