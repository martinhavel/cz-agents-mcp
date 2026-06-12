import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SanctionsDb } from '../db.js';
import type { SanctionedEntity } from '../types.js';

function ent(id: string, name: string, over: Partial<SanctionedEntity> = {}): SanctionedEntity {
  return {
    id: `eu:${id}`,
    source: 'eu',
    source_list_id: id,
    type: 'person',
    primary_name: name,
    aliases: over.aliases ?? [],
    programs: over.programs ?? [],
    dobs: over.dobs,
    ids: over.ids,
    listed_on: over.listed_on,
    nationalities: over.nationalities,
    addresses: over.addresses,
  };
}

describe('SanctionsDb', () => {
  let tmp: string;
  let db: SanctionsDb;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'czagents-sanctions-'));
    db = new SanctionsDb(join(tmp, 'test.db'));
  });

  afterEach(() => {
    db.close();
    rmSync(tmp, { recursive: true, force: true });
  });

  it('upsertSource counts adds on first run', () => {
    const diff = db.upsertSource('eu', [ent('a', 'Alice'), ent('b', 'Bob')]);
    expect(diff).toEqual({ added: 2, modified: 0, removed: 0 });
  });

  it('upsertSource detects modifications', () => {
    db.upsertSource('eu', [ent('a', 'Alice')]);
    const diff = db.upsertSource('eu', [ent('a', 'Alice Updated')]);
    expect(diff).toEqual({ added: 0, modified: 1, removed: 0 });
  });

  it('upsertSource soft-deletes missing records', () => {
    db.upsertSource('eu', [ent('a', 'Alice'), ent('b', 'Bob')]);
    const diff = db.upsertSource('eu', [ent('a', 'Alice')]);
    expect(diff).toEqual({ added: 0, modified: 0, removed: 1 });
    expect(db.getById('eu:b')).toBeNull();
  });

  it('only soft-deletes within same source', () => {
    db.upsertSource('eu', [ent('a', 'Alice')]);
    db.upsertSource('ofac', [{ ...ent('x', 'Xander'), id: 'ofac:x', source: 'ofac' }]);
    const diff = db.upsertSource('eu', [ent('a', 'Alice')]);
    expect(diff.removed).toBe(0);
    expect(db.getById('ofac:x')).not.toBeNull();
  });

  it('getById returns null for removed', () => {
    db.upsertSource('eu', [ent('a', 'Alice')]);
    db.upsertSource('eu', []);
    expect(db.getById('eu:a')).toBeNull();
  });

  it('findByExternalId returns matching entities', () => {
    db.upsertSource('eu', [
      ent('p1', 'Person', { ids: [{ type: 'passport', value: 'X1' }] }),
    ]);
    expect(db.findByExternalId('passport', 'X1')).toHaveLength(1);
    expect(db.findByExternalId('passport', 'X2')).toHaveLength(0);
  });

  it('candidatesByTokens prefilters by alias substring', () => {
    db.upsertSource('eu', [
      ent('a', 'Vladimir Putin', { aliases: ['Володимир Путін'] }),
      ent('b', 'Jane Doe'),
    ]);
    const cands = db.candidatesByTokens(['vladimir']);
    expect(cands.find((c) => c.id === 'eu:a')).toBeDefined();
    expect(cands.find((c) => c.id === 'eu:b')).toBeUndefined();
  });

  it('candidatesByTokens treats LIKE wildcards in tokens as literals (no over-match)', () => {
    db.upsertSource('eu', [ent('a', 'Alice'), ent('b', 'Bob')]);
    // A bare '%' token, unescaped, would become '%%%' and match every alias. Escaped,
    // it only matches aliases literally containing '%' — none here.
    expect(db.candidatesByTokens(['%'])).toHaveLength(0);
    // Similarly '_' must not act as a single-char wildcard.
    expect(db.candidatesByTokens(['_'])).toHaveLength(0);
    // A literal substring token still matches normally.
    expect(db.candidatesByTokens(['alice']).find((c) => c.id === 'eu:a')).toBeDefined();
  });

  it('activeCountForSource counts only active rows per source', () => {
    db.upsertSource('eu', [ent('a', 'Alice'), ent('b', 'Bob')]);
    db.upsertSource('ofac', [{ ...ent('x', 'Xander'), id: 'ofac:x', source: 'ofac' }]);
    expect(db.activeCountForSource('eu')).toBe(2);
    expect(db.activeCountForSource('ofac')).toBe(1);
    db.upsertSource('eu', [ent('a', 'Alice')]); // soft-delete b
    expect(db.activeCountForSource('eu')).toBe(1);
  });

  it('changesSince captures add/modify/remove buckets', async () => {
    db.upsertSource('eu', [ent('a', 'Alice')]);
    const t0 = Date.now() + 1;
    await new Promise((r) => setTimeout(r, 5));
    db.upsertSource('eu', [ent('a', 'Alice 2'), ent('b', 'Bob')]);
    await new Promise((r) => setTimeout(r, 5));
    db.upsertSource('eu', [ent('b', 'Bob')]);

    const changes = db.changesSince(t0);
    // Final per-entity state in window: a=modify (or remove), b=add
    expect(changes.added.find((e) => e.id === 'eu:b')).toBeDefined();
    // a was modified then removed → final op is 'remove'
    expect(changes.removed.find((e) => e.id === 'eu:a')).toBeDefined();
  });

  it('stats reports counts and sources', () => {
    db.upsertSource('eu', [ent('a', 'Alice'), ent('b', 'Bob')]);
    const stats = db.stats();
    expect(stats.total_active).toBe(2);
    expect(stats.by_source.eu).toBe(2);
    expect(stats.refresh_log.find((l) => l.source === 'eu')!.ok).toBe(true);
  });

  it('recordRefreshFailure logs error', () => {
    db.recordRefreshFailure('ofac', 'connection timeout');
    const stats = db.stats();
    const log = stats.refresh_log.find((l) => l.source === 'ofac');
    expect(log!.ok).toBe(false);
    expect(log!.error).toBe('connection timeout');
  });
});
