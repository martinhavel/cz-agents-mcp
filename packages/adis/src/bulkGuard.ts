import { createHash } from 'node:crypto';

export interface BulkGuardOptions {
  limit: number;
  windowMs: number;
  maxSignatures?: number;
  now?: () => number;
}

interface WindowState {
  count: number;
  resetAt: number;
}

export class BulkSignatureQuotaExceeded extends Error {
  readonly code = 'ADIS_BULK_SIGNATURE_QUOTA';

  constructor(readonly retryAfterSeconds: number) {
    super(`Bulk ADIS quota exceeded for this request signature. Retry in ${retryAfterSeconds}s.`);
    this.name = 'BulkSignatureQuotaExceeded';
  }
}

export function normalizeUserAgent(value: string | undefined): string {
  return (value ?? '').trim().replace(/\s+/g, ' ').toLowerCase();
}

export function createBulkSignatureGuard(options: BulkGuardOptions) {
  const states = new Map<string, WindowState>();
  const maxSignatures = options.maxSignatures ?? 10_000;
  const now = options.now ?? Date.now;
  const limit = Number.isInteger(options.limit) && options.limit > 0 ? options.limit : 0;
  const windowMs = Number.isFinite(options.windowMs) && options.windowMs > 0
    ? options.windowMs
    : 3_600_000;

  return {
    check(userAgent: string | undefined, canonicalDics: string[]): void {
      // Zero is the safe rollout default: prepared code has no runtime effect.
      if (limit === 0) return;

      const timestamp = now();
      const signature = createHash('sha256')
        .update(normalizeUserAgent(userAgent))
        .update('\0')
        .update([...canonicalDics].sort().join('\0'))
        .digest('hex');
      const previous = states.get(signature);

      if (!previous || timestamp >= previous.resetAt) {
        if (!previous && states.size >= maxSignatures) {
          const oldest = states.keys().next().value as string | undefined;
          if (oldest) states.delete(oldest);
        }
        states.delete(signature);
        states.set(signature, { count: 1, resetAt: timestamp + windowMs });
        return;
      }

      // Refresh insertion order for bounded oldest-first eviction.
      states.delete(signature);
      states.set(signature, previous);
      if (previous.count >= limit) {
        throw new BulkSignatureQuotaExceeded(Math.max(1, Math.ceil((previous.resetAt - timestamp) / 1000)));
      }
      previous.count += 1;
    },
  };
}
