import type { IncomingMessage, ServerResponse } from 'node:http';
import { TtlMap } from './cache.js';

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
  /** Maximum distinct IP buckets retained in memory. */
  maxBuckets?: number;
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
  const buckets = new TtlMap<string, Bucket>({
    ttlMs: windowMs,
    maxSize: opts.maxBuckets ?? 50_000,
    sweepIntervalMs: 120_000,
  });

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
          message: `Too many requests. Retry after ${retryAfter}s. Higher limits at https://cz-agents.dev/pricing.html`,
          retry_after_seconds: retryAfter,
          upgrade_url: 'https://cz-agents.dev/pricing.html?utm_source=mcp&utm_medium=ratelimit',
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
 * Resolve the real client IP behind the Cloudflare → cloudflared → apache chain.
 *
 * The single source of truth for client-IP extraction across every cz-agents MCP
 * server (rate limiting, session limiting, logging, lead attribution).
 *
 * We read the LAST element of X-Forwarded-For: apache (mod_remoteip + ProxyPass)
 * appends the resolved client as the final hop, so that element is proxy-trusted
 * and spoof-safe — a client-supplied X-Forwarded-For only ever lands earlier in
 * the list. We deliberately IGNORE CF-Connecting-IP: the apache vhost overwrites
 * it with a literal "%a" (a broken ap_expr) in this topology, so it carries no
 * usable value. Verified empirically 2026-06-07 via a header-dump on ares behind
 * the production tunnel (XFF arrived as "realIP, realIP"; cf-connecting-ip "%a").
 */
export function getClientIp(req: IncomingMessage): string {
  const xff = req.headers['x-forwarded-for'];
  if (typeof xff === 'string' && xff.length > 0) {
    const parts = xff.split(',');
    const last = parts[parts.length - 1]?.trim();
    if (last) return stripV4MappedPrefix(last);
  }
  return stripV4MappedPrefix(req.socket.remoteAddress ?? 'unknown');
}

/** Normalize IPv4-mapped IPv6 (::ffff:1.2.3.4) down to plain IPv4 for stable keys. */
function stripV4MappedPrefix(ip: string): string {
  return ip.startsWith('::ffff:') ? ip.slice(7) : ip;
}

function defaultGetIp(req: IncomingMessage): string {
  return getClientIp(req);
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
