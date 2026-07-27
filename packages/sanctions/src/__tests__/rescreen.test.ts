import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SanctionsDb } from '../db.js';
import {
  rescreenPortfolio,
  RescreenValidationError,
  MAX_PORTFOLIO_SUBJECTS,
  MAX_PORTFOLIO_SUBJECTS_X402,
  type PortfolioSubject,
} from '../rescreen.js';
import type { SanctionedEntity } from '../types.js';

function ent(id: string, name: string, over: Partial<SanctionedEntity> = {}): SanctionedEntity {
  return {
    id: `eu:${id}`,
    source: 'eu',
    source_list_id: id,
    type: over.type ?? 'person',
    primary_name: name,
    aliases: over.aliases ?? [],
    programs: over.programs ?? ['EU.TEST'],
    dobs: over.dobs,
    ids: over.ids,
    listed_on: over.listed_on,
    nationalities: over.nationalities,
    addresses: over.addresses,
  };
}

describe('rescreenPortfolio', () => {
  let tmp: string;
  let db: SanctionsDb;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'czagents-sanctions-rescreen-'));
    db = new SanctionsDb(join(tmp, 'test.db'));
  });

  afterEach(() => {
    db.close();
    rmSync(tmp, { recursive: true, force: true });
  });

  // --- validation -----------------------------------------------------

  it('rejects an empty subject list', () => {
    expect(() => rescreenPortfolio({ db }, { subjects: [], sinceMs: Date.now() - 1000 })).toThrow(
      RescreenValidationError,
    );
  });

  it('rejects a subject missing ref', () => {
    const subjects = [{ name: 'Alice' } as unknown as PortfolioSubject];
    expect(() => rescreenPortfolio({ db }, { subjects, sinceMs: Date.now() - 1000 })).toThrow(
      /ref/,
    );
  });

  it('rejects a subject with neither name nor ico', () => {
    const subjects: PortfolioSubject[] = [{ ref: 'client-1' }];
    expect(() => rescreenPortfolio({ db }, { subjects, sinceMs: Date.now() - 1000 })).toThrow(
      /neither "name" nor "ico"/,
    );
  });

  it('rejects sinceMs in the future', () => {
    const subjects: PortfolioSubject[] = [{ ref: 'client-1', name: 'Alice' }];
    expect(() =>
      rescreenPortfolio({ db }, { subjects, sinceMs: Date.now() + 60_000 }),
    ).toThrow(/future/);
  });

  it('rejects too many subjects', () => {
    const subjects: PortfolioSubject[] = Array.from({ length: MAX_PORTFOLIO_SUBJECTS + 1 }, (_, i) => ({
      ref: `c${i}`,
      name: `Person ${i}`,
    }));
    expect(() => rescreenPortfolio({ db }, { subjects, sinceMs: Date.now() - 1000 })).toThrow(
      /cap of/,
    );
  });

  it('accepts exactly the cap', () => {
    const subjects: PortfolioSubject[] = Array.from({ length: MAX_PORTFOLIO_SUBJECTS }, (_, i) => ({
      ref: `c${i}`,
      name: `Person ${i}`,
    }));
    expect(() => rescreenPortfolio({ db }, { subjects, sinceMs: Date.now() - 1000 })).not.toThrow();
  });

  // --- maxSubjects override (x402 pricing gap) -------------------------

  it('a maxSubjects override rejects a batch that would pass the default 500 cap', () => {
    // The whole point of the override: a caller sized for the x402 per-call
    // price must not be able to slip in a portfolio sized for the token path.
    const subjects: PortfolioSubject[] = Array.from({ length: MAX_PORTFOLIO_SUBJECTS_X402 + 1 }, (_, i) => ({
      ref: `c${i}`,
      name: `Person ${i}`,
    }));
    expect(subjects.length).toBeLessThan(MAX_PORTFOLIO_SUBJECTS); // sanity: still under the default cap
    expect(() =>
      rescreenPortfolio({ db }, { subjects, sinceMs: Date.now() - 1000, maxSubjects: MAX_PORTFOLIO_SUBJECTS_X402 }),
    ).toThrow(/over the cap of 11/);
  });

  it('a maxSubjects override accepts exactly its own cap, not silently truncating', () => {
    const subjects: PortfolioSubject[] = Array.from({ length: MAX_PORTFOLIO_SUBJECTS_X402 }, (_, i) => ({
      ref: `c${i}`,
      name: `Person ${i}`,
    }));
    const result = rescreenPortfolio(
      { db },
      { subjects, sinceMs: Date.now() - 1000, maxSubjects: MAX_PORTFOLIO_SUBJECTS_X402 },
    );
    // Screened count must equal what was submitted — no truncation to the cap.
    expect(result.summary.subjects_screened).toBe(MAX_PORTFOLIO_SUBJECTS_X402);
  });

  it('not passing maxSubjects still allows the full 500-subject default (token path unaffected)', () => {
    const subjects: PortfolioSubject[] = Array.from({ length: MAX_PORTFOLIO_SUBJECTS }, (_, i) => ({
      ref: `c${i}`,
      name: `Person ${i}`,
    }));
    const result = rescreenPortfolio({ db }, { subjects, sinceMs: Date.now() - 1000 });
    expect(result.summary.subjects_screened).toBe(MAX_PORTFOLIO_SUBJECTS);
  });

  it('rejects a non-array subjects value', () => {
    expect(() =>
      rescreenPortfolio({ db }, { subjects: 'nope' as unknown as PortfolioSubject[], sinceMs: Date.now() }),
    ).toThrow(RescreenValidationError);
  });

  it('rejects an out-of-range threshold', () => {
    const subjects: PortfolioSubject[] = [{ ref: 'client-1', name: 'Alice' }];
    expect(() =>
      rescreenPortfolio({ db }, { subjects, sinceMs: Date.now() - 1000, threshold: 150 }),
    ).toThrow(/threshold/);
  });

  // --- empty window -----------------------------------------------------

  it('returns an empty result for a window with no changes', async () => {
    db.upsertSource('eu', [ent('a', 'Alice Wonderland')]);
    await new Promise((r) => setTimeout(r, 5));
    const t0 = Date.now(); // after the only change, still in the past
    const result = rescreenPortfolio(
      { db },
      { subjects: [{ ref: 'client-1', name: 'Alice Wonderland' }], sinceMs: t0 },
    );
    expect(result.matches).toHaveLength(0);
    expect(result.summary.changes_in_window).toBe(0);
    expect(result.summary.subjects_affected).toBe(0);
    expect(result.summary.subjects_screened).toBe(1);
  });

  // --- added / removed / modified / unaffected --------------------------

  it('flags a subject hit by an addition', async () => {
    const t0 = Date.now();
    await new Promise((r) => setTimeout(r, 5));
    db.upsertSource('eu', [ent('a', 'Vladimir Putin', { programs: ['EU.RUSSIA'] })]);

    const result = rescreenPortfolio(
      { db },
      { subjects: [{ ref: 'client-1', name: 'Vladimir Putin' }], sinceMs: t0 },
    );

    expect(result.matches).toHaveLength(1);
    const m = result.matches[0]!;
    expect(m.ref).toBe('client-1');
    expect(m.change_type).toBe('added');
    expect(m.matched_on).toBe('name');
    expect(m.confidence).toBeGreaterThanOrEqual(80);
    expect(m.entity.id).toBe('eu:a');
    expect(m.entity.programs).toEqual(['EU.RUSSIA']);
    expect(result.summary.subjects_affected).toBe(1);
    expect(result.summary.changes_in_window).toBe(1);
  });

  it('flags a subject hit by a removal', async () => {
    db.upsertSource('eu', [ent('a', 'Alice Wonderland')]);
    const t0 = Date.now() + 1;
    await new Promise((r) => setTimeout(r, 5));
    db.upsertSource('eu', []); // Alice delisted

    const result = rescreenPortfolio(
      { db },
      { subjects: [{ ref: 'client-1', name: 'Alice Wonderland' }], sinceMs: t0 },
    );

    expect(result.matches).toHaveLength(1);
    const m = result.matches[0]!;
    expect(m.change_type).toBe('removed');
    expect(m.entity.id).toBe('eu:a');
  });

  it('flags a subject hit by a modification and shows changed fields', async () => {
    db.upsertSource('eu', [ent('a', 'Alice Wonderland', { programs: ['EU.OLD'] })]);
    const t0 = Date.now() + 1;
    await new Promise((r) => setTimeout(r, 5));
    db.upsertSource('eu', [ent('a', 'Alice Wonderland', { programs: ['EU.NEW'] })]);

    const result = rescreenPortfolio(
      { db },
      { subjects: [{ ref: 'client-1', name: 'Alice Wonderland' }], sinceMs: t0 },
    );

    expect(result.matches).toHaveLength(1);
    const m = result.matches[0]!;
    expect(m.change_type).toBe('modified');
    expect(m.matched_against).toBe('after');
    expect(m.changed_fields).toBeDefined();
    const programsChange = m.changed_fields!.find((c) => c.field === 'programs');
    expect(programsChange).toEqual({ field: 'programs', before: ['EU.OLD'], after: ['EU.NEW'] });
  });

  it('flags a subject that only matches the pre-change (before) state of a modification', async () => {
    db.upsertSource('eu', [ent('a', 'Alice Wonderland')]);
    const t0 = Date.now() + 1;
    await new Promise((r) => setTimeout(r, 5));
    // Renamed away from what the subject knows it by.
    db.upsertSource('eu', [ent('a', 'Alicia W. Marquez')]);

    const result = rescreenPortfolio(
      { db },
      { subjects: [{ ref: 'client-1', name: 'Alice Wonderland' }], sinceMs: t0 },
    );

    expect(result.matches).toHaveLength(1);
    const m = result.matches[0]!;
    expect(m.change_type).toBe('modified');
    expect(m.matched_against).toBe('before');
  });

  it('does not include an unaffected subject in the output', async () => {
    const t0 = Date.now();
    await new Promise((r) => setTimeout(r, 5));
    db.upsertSource('eu', [ent('a', 'Vladimir Putin')]);

    const result = rescreenPortfolio(
      { db },
      {
        subjects: [
          { ref: 'client-1', name: 'Vladimir Putin' },
          { ref: 'client-2', name: 'Completely Unrelated Person' },
        ],
        sinceMs: t0,
      },
    );

    expect(result.matches.map((m) => m.ref)).toEqual(['client-1']);
    expect(result.summary.subjects_screened).toBe(2);
    expect(result.summary.subjects_affected).toBe(1);
  });

  // --- matching by ico vs name --------------------------------------------

  it('matches by IČO with confidence 100', async () => {
    const t0 = Date.now();
    await new Promise((r) => setTimeout(r, 5));
    db.upsertSource('eu', [
      ent('co', 'Bad Czech Co.', { type: 'entity', ids: [{ type: 'ico', value: '12345678', country: 'CZ' }] }),
    ]);

    const result = rescreenPortfolio(
      { db },
      { subjects: [{ ref: 'client-1', ico: '12345678' }], sinceMs: t0 },
    );

    expect(result.matches).toHaveLength(1);
    const m = result.matches[0]!;
    expect(m.matched_on).toBe('ico');
    expect(m.confidence).toBe(100);
  });

  it('does not match on an unrelated ico', async () => {
    const t0 = Date.now();
    await new Promise((r) => setTimeout(r, 5));
    db.upsertSource('eu', [
      ent('co', 'Bad Czech Co.', { type: 'entity', ids: [{ type: 'ico', value: '12345678', country: 'CZ' }] }),
    ]);

    const result = rescreenPortfolio(
      { db },
      { subjects: [{ ref: 'client-1', ico: '99999999' }], sinceMs: t0 },
    );

    expect(result.matches).toHaveLength(0);
  });

  it('respects a custom threshold', async () => {
    const t0 = Date.now();
    await new Promise((r) => setTimeout(r, 5));
    db.upsertSource('eu', [ent('a', 'Jon Smith')]);

    const strict = rescreenPortfolio(
      { db },
      { subjects: [{ ref: 'client-1', name: 'John Smithe' }], sinceMs: t0, threshold: 99 },
    );
    const loose = rescreenPortfolio(
      { db },
      { subjects: [{ ref: 'client-1', name: 'John Smithe' }], sinceMs: t0, threshold: 50 },
    );

    expect(strict.matches.length).toBeLessThanOrEqual(loose.matches.length);
    expect(loose.matches.length).toBeGreaterThan(0);
  });

  it('honors the source filter', async () => {
    const t0 = Date.now();
    await new Promise((r) => setTimeout(r, 5));
    db.upsertSource('eu', [ent('a', 'Vladimir Putin')]);
    db.upsertSource('ofac', [{ ...ent('b', 'Vladimir Putin'), id: 'ofac:b', source: 'ofac' }]);

    const result = rescreenPortfolio(
      { db },
      { subjects: [{ ref: 'client-1', name: 'Vladimir Putin' }], sinceMs: t0, source: 'eu' },
    );

    expect(result.matches).toHaveLength(1);
    expect(result.matches[0]!.entity.source).toBe('eu');
    expect(result.summary.source).toBe('eu');
  });
});
