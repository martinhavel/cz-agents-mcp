import { describe, it, expect } from 'vitest';
import { sanctionsDbHealthWarning, SANCTIONS_STALE_THRESHOLD_MS } from '../server.js';
import type { DbStats } from '../db.js';

const NOW = Date.parse('2026-06-13T12:00:00Z');

function stats(over: Partial<DbStats> = {}): DbStats {
  return {
    total_active: 100,
    total_removed: 0,
    by_source: { eu: 60, ofac: 40 },
    refresh_log: [
      { source: 'eu', refreshed_at: new Date(NOW - 60 * 60 * 1000).toISOString(), source_count: 60, ok: true, error: null },
    ],
    ...over,
  };
}

describe('sanctionsDbHealthWarning — no silent clean from empty/stale DB', () => {
  it('returns null when DB is loaded and fresh (clean verdict allowed)', () => {
    expect(sanctionsDbHealthWarning(stats(), NOW)).toBeNull();
  });

  it('warns when DB is empty (0 active)', () => {
    const w = sanctionsDbHealthWarning(stats({ total_active: 0 }), NOW);
    expect(w).toMatch(/NENÍ načten|0 záznamů/);
    expect(w).toMatch(/NELZE potvrdit/);
  });

  it('warns when there is no successful refresh record', () => {
    const w = sanctionsDbHealthWarning(stats({ refresh_log: [] }), NOW);
    expect(w).toMatch(/stáří dat nelze ověřit/);
  });

  it('treats a failed-only refresh log as no usable record', () => {
    const w = sanctionsDbHealthWarning(
      stats({ refresh_log: [{ source: 'eu', refreshed_at: new Date(NOW).toISOString(), source_count: 0, ok: false, error: 'timeout' }] }),
      NOW,
    );
    expect(w).toMatch(/stáří dat nelze ověřit/);
  });

  it('warns when newest successful refresh is older than 48h', () => {
    const old = new Date(NOW - SANCTIONS_STALE_THRESHOLD_MS - 60 * 60 * 1000).toISOString();
    const w = sanctionsDbHealthWarning(
      stats({ refresh_log: [{ source: 'eu', refreshed_at: old, source_count: 60, ok: true, error: null }] }),
      NOW,
    );
    expect(w).toMatch(/zastaralý/);
    expect(w).toMatch(/NELZE považovat za potvrzené čisto/);
  });

  it('stays clean exactly at the freshness boundary', () => {
    const edge = new Date(NOW - SANCTIONS_STALE_THRESHOLD_MS).toISOString();
    const w = sanctionsDbHealthWarning(
      stats({ refresh_log: [{ source: 'eu', refreshed_at: edge, source_count: 60, ok: true, error: null }] }),
      NOW,
    );
    expect(w).toBeNull();
  });
});
