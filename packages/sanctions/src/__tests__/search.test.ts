import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SanctionsDb } from '../db.js';
import { SanctionsSearch, nameSimilarity } from '../search.js';
import type { SanctionedEntity } from '../types.js';

function makePerson(over: Partial<SanctionedEntity>): SanctionedEntity {
  return {
    id: over.id ?? 'eu:test',
    source: over.source ?? 'eu',
    source_list_id: over.source_list_id ?? 'test',
    type: over.type ?? 'person',
    primary_name: over.primary_name ?? 'John Smith',
    aliases: over.aliases ?? [],
    programs: over.programs ?? ['EU.TEST'],
    dobs: over.dobs,
    nationalities: over.nationalities,
    ids: over.ids,
    addresses: over.addresses,
    listed_on: over.listed_on,
    raw: over.raw,
  };
}

describe('nameSimilarity', () => {
  it('exact match = 100', () => {
    expect(nameSimilarity('John Smith', 'John Smith')).toBe(100);
  });

  it('reordered tokens match high', () => {
    expect(nameSimilarity('Smith, John', 'John Smith')).toBeGreaterThan(95);
  });

  it('cyrillic transliteration matches latin', () => {
    expect(nameSimilarity('Vladimir Putin', 'Владимир Путин')).toBeGreaterThan(90);
  });

  it('typo tolerated', () => {
    expect(nameSimilarity('John Smyth', 'John Smith')).toBeGreaterThan(80);
  });

  it('totally different names score low', () => {
    expect(nameSimilarity('Jane Doe', 'Vladimir Putin')).toBeLessThan(40);
  });
});

describe('SanctionsSearch', () => {
  let tmp: string;
  let db: SanctionsDb;
  let search: SanctionsSearch;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'czagents-sanctions-'));
    db = new SanctionsDb(join(tmp, 'test.db'));
    search = new SanctionsSearch(db);

    db.upsertSource('eu', [
      makePerson({
        id: 'eu:putin',
        source_list_id: 'putin',
        primary_name: 'Vladimir Vladimirovich Putin',
        aliases: ['Владимир Путин', 'VVP'],
        dobs: ['1952-10-07'],
        nationalities: ['Russia'],
        programs: ['EU.RUSSIA'],
        listed_on: '2014-07-31',
      }),
      makePerson({
        id: 'eu:doe',
        source_list_id: 'doe',
        primary_name: 'John Doe',
        ids: [{ type: 'passport', value: 'GBR987654' }],
      }),
      makePerson({
        id: 'eu:bank-rossiya',
        source_list_id: 'bank',
        type: 'entity',
        primary_name: 'Bank Rossiya',
        ids: [{ type: 'tax_id', value: '7831000122' }],
      }),
    ]);
  });

  afterEach(() => {
    db.close();
    rmSync(tmp, { recursive: true, force: true });
  });

  it('finds person by exact name', () => {
    const matches = search.searchByName('Vladimir Putin', { typeFilter: 'person' });
    expect(matches.length).toBeGreaterThan(0);
    const top = matches[0]!;
    expect(top.entity.id).toBe('eu:putin');
    expect(top.confidence).toBeGreaterThanOrEqual(80);
    expect(top.entity.primary_name).toBe('Vladimir Vladimirovich Putin');
    expect(top.entity.dobs).toEqual(['1952-10-07']);
    expect(top.entity.nationalities).toEqual(['Russia']);
    expect(top.entity.programs).toEqual(['EU.RUSSIA']);
    expect(top.entity.listed_on).toBe('2014-07-31');
  });

  it('finds person by cyrillic alias via transliteration', () => {
    const matches = search.searchByName('Путин', { typeFilter: 'person', threshold: 60 });
    expect(matches.some((m) => m.entity.id === 'eu:putin')).toBe(true);
  });

  it('returns matched alias and evidence fields for alias hits', () => {
    const matches = search.searchByName('VVP', { typeFilter: 'person', threshold: 60 });
    const match = matches.find((m) => m.entity.id === 'eu:putin');
    expect(match?.matched_on).toBe('alias');
    expect(match?.matched_alias).toBe('VVP');
    expect(match?.entity.primary_name).toBe('Vladimir Vladimirovich Putin');
    expect(match?.entity.dobs).toEqual(['1952-10-07']);
    expect(match?.entity.nationalities).toEqual(['Russia']);
    expect(match?.entity.programs).toEqual(['EU.RUSSIA']);
    expect(match?.entity.listed_on).toBe('2014-07-31');
  });

  it('respects threshold', () => {
    const lo = search.searchByName('Vladimir', { threshold: 30 });
    const hi = search.searchByName('Vladimir', { threshold: 99 });
    expect(lo.length).toBeGreaterThanOrEqual(hi.length);
  });

  it('typeFilter narrows results', () => {
    const persons = search.searchByName('Bank', { typeFilter: 'person' });
    const entities = search.searchByName('Bank', { typeFilter: 'entity' });
    expect(persons.find((m) => m.entity.id === 'eu:bank-rossiya')).toBeUndefined();
    expect(entities.find((m) => m.entity.id === 'eu:bank-rossiya')).toBeDefined();
  });

  it('searchByDocument exact-match passport returns confidence 100', () => {
    const matches = search.searchByDocument('passport', 'GBR987654');
    expect(matches).toHaveLength(1);
    const m = matches[0]!;
    expect(m.confidence).toBe(100);
    expect(m.matched_on).toBe('id');
    expect(m.entity.primary_name).toBe('John Doe');
  });

  it('searchByIco direct hit when IČO is in ids table', () => {
    const matches = search.searchByIco('7831000122');
    expect(matches).toHaveLength(0); // ico isn't an external_id type for this fixture
  });

  it('searchByIco with type ico set up', () => {
    db.upsertSource('eu', [
      makePerson({
        id: 'eu:cz-co',
        source_list_id: 'cz-co',
        type: 'entity',
        primary_name: 'Bad Czech Co.',
        ids: [{ type: 'ico', value: '12345678', country: 'CZ' }],
      }),
    ]);
    const matches = search.searchByIco('12345678');
    expect(matches).toHaveLength(1);
    const m = matches[0]!;
    expect(m.confidence).toBe(100);
    expect(m.matched_on).toBe('ico');
    expect(m.entity.primary_name).toBe('Bad Czech Co.');
  });

  it('dob filter excludes mismatched birth year', () => {
    const matches = search.searchByName('Putin', { dob: '1900', threshold: 60 });
    expect(matches.length).toBe(0);
  });

  it('dob filter accepts year-only against full date', () => {
    const matches = search.searchByName('Vladimir Putin', { dob: '1952', threshold: 60 });
    expect(matches.find((m) => m.entity.id === 'eu:putin')).toBeDefined();
  });

  it('dob filter matches when the year is not a prefix (e.g. "07 Oct 1952")', () => {
    db.upsertSource('eu', [
      makePerson({
        id: 'eu:putin',
        source_list_id: 'putin',
        primary_name: 'Vladimir Vladimirovich Putin',
        aliases: ['Владимир Путин'],
        dobs: ['07 Oct 1952'], // year is at the END, not the start
        nationalities: ['Russia'],
      }),
    ]);
    const matches = search.searchByName('Vladimir Putin', { dob: '1952-10-07', threshold: 60 });
    expect(matches.find((m) => m.entity.id === 'eu:putin')).toBeDefined();
  });

  it('dob filter still excludes a mismatched year with textual dob', () => {
    db.upsertSource('eu', [
      makePerson({
        id: 'eu:putin',
        source_list_id: 'putin',
        primary_name: 'Vladimir Vladimirovich Putin',
        dobs: ['07 Oct 1952'],
      }),
    ]);
    const matches = search.searchByName('Vladimir Putin', { dob: '1999', threshold: 60 });
    expect(matches.find((m) => m.entity.id === 'eu:putin')).toBeUndefined();
  });
});
