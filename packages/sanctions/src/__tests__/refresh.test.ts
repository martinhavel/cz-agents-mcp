import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SanctionsDb } from '../db.js';
import { refreshSource } from '../refresh.js';
import type { SourceDef } from '../fetchers/index.js';
import type { SanctionedEntity } from '../types.js';

function ent(id: string, name: string): SanctionedEntity {
  return {
    id: `eu:${id}`,
    source: 'eu',
    source_list_id: id,
    type: 'person',
    primary_name: name,
    aliases: [],
    programs: [],
  };
}

function defReturning(entities: SanctionedEntity[]): SourceDef {
  return {
    source: 'eu',
    url: () => 'https://example.test/list.xml',
    parse: () => entities,
    required: false,
  };
}

describe('refreshSource empty/drop guard', () => {
  let tmp: string;
  let db: SanctionsDb;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'czagents-refresh-'));
    db = new SanctionsDb(join(tmp, 'test.db'));
    // Stub fetch so the parser stub's input is irrelevant.
    vi.stubGlobal('fetch', vi.fn(async () => new Response('<xml/>', { status: 200 })));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    db.close();
    rmSync(tmp, { recursive: true, force: true });
  });

  it('refuses to wipe the list when parse returns 0 entities', async () => {
    db.upsertSource('eu', [ent('a', 'Alice'), ent('b', 'Bob')]);
    const summary = await refreshSource(db, defReturning([]));
    expect(summary.ok).toBe(false);
    expect(summary.error).toMatch(/refusing to wipe/i);
    // Data preserved.
    expect(db.activeCountForSource('eu')).toBe(2);
    expect(db.getById('eu:a')).not.toBeNull();
  });

  it('refuses to apply a >50% drop', async () => {
    db.upsertSource('eu', [ent('a', 'A'), ent('b', 'B'), ent('c', 'C'), ent('d', 'D')]);
    const summary = await refreshSource(db, defReturning([ent('a', 'A')])); // 1 of 4
    expect(summary.ok).toBe(false);
    expect(summary.error).toMatch(/>50% drop|drop from/i);
    expect(db.activeCountForSource('eu')).toBe(4);
  });

  it('applies a normal refresh', async () => {
    db.upsertSource('eu', [ent('a', 'A'), ent('b', 'B')]);
    const summary = await refreshSource(db, defReturning([ent('a', 'A'), ent('b', 'B'), ent('c', 'C')]));
    expect(summary.ok).toBe(true);
    expect(db.activeCountForSource('eu')).toBe(3);
  });

  it('allows the very first load (no existing active rows)', async () => {
    const summary = await refreshSource(db, defReturning([]));
    expect(summary.ok).toBe(true);
    expect(db.activeCountForSource('eu')).toBe(0);
  });
});
