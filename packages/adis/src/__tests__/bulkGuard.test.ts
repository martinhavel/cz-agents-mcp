import { describe, expect, it } from 'vitest';
import { BulkSignatureQuotaExceeded, createBulkSignatureGuard } from '../bulkGuard.js';

describe('bulk signature guard', () => {
  it('is inert when the rollout limit is disabled', () => {
    const guard = createBulkSignatureGuard({ limit: 0, windowMs: 60_000 });
    for (let i = 0; i < 10; i += 1) guard.check('python-requests/2.32.5', ['CZ11122234']);
    const malformed = createBulkSignatureGuard({ limit: Number.NaN, windowMs: Number.NaN });
    for (let i = 0; i < 10; i += 1) malformed.check('python-requests/2.32.5', ['CZ11122234']);
  });

  it('aggregates the same UA and canonical DIČ set independently of IP or input order', () => {
    const guard = createBulkSignatureGuard({ limit: 2, windowMs: 60_000 });
    guard.check(' Python-Requests/2.32.5 ', ['CZ2', 'CZ1']);
    guard.check('python-requests/2.32.5', ['CZ1', 'CZ2']);
    expect(() => guard.check('python-requests/2.32.5', ['CZ2', 'CZ1']))
      .toThrow(BulkSignatureQuotaExceeded);
  });

  it('does not merge different arguments or user agents and resets after the window', () => {
    let timestamp = 1_000;
    const guard = createBulkSignatureGuard({ limit: 1, windowMs: 500, now: () => timestamp });
    guard.check('python-requests/2.32.5', ['CZ1']);
    guard.check('python-requests/2.32.5', ['CZ2']);
    guard.check('Go-http-client/2.0', ['CZ1']);
    expect(() => guard.check('python-requests/2.32.5', ['CZ1'])).toThrow(BulkSignatureQuotaExceeded);
    timestamp += 500;
    guard.check('python-requests/2.32.5', ['CZ1']);
  });

  it('keeps state bounded', () => {
    const guard = createBulkSignatureGuard({ limit: 1, windowMs: 60_000, maxSignatures: 2 });
    guard.check('ua', ['CZ1']);
    guard.check('ua', ['CZ2']);
    guard.check('ua', ['CZ3']);
    // CZ1 was the oldest entry and was evicted instead of growing the map forever.
    guard.check('ua', ['CZ1']);
  });
});
