import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { parseEu } from '../fetchers/eu.js';

const here = dirname(fileURLToPath(import.meta.url));
const xml = readFileSync(join(here, 'fixtures/eu-sample.xml'), 'utf8');

describe('parseEu', () => {
  it('parses 3 entities', () => {
    const entities = parseEu(xml);
    expect(entities).toHaveLength(3);
  });

  it('namespaces ids with eu: prefix', () => {
    const entities = parseEu(xml);
    expect(entities.every((e) => e.id.startsWith('eu:'))).toBe(true);
  });

  it('extracts primary name and aliases for persons', () => {
    const entities = parseEu(xml);
    const putin = entities.find((e) => e.source_list_id === 'EU.13845.2014');
    expect(putin).toBeDefined();
    expect(putin!.primary_name).toBe('Vladimir Vladimirovich Putin');
    expect(putin!.type).toBe('person');
    expect(putin!.aliases).toContain('Владимир Владимирович Путин');
  });

  it('classifies entity type from subjectType code', () => {
    const entities = parseEu(xml);
    const bank = entities.find((e) => e.source_list_id === 'EU.999.2022');
    expect(bank!.type).toBe('entity');
  });

  it('captures dob, nationality, addresses, ids', () => {
    const entities = parseEu(xml);
    const doe = entities.find((e) => e.source_list_id === 'EU.42.2025');
    expect(doe!.dobs).toEqual(['1978-03-14']);
    expect(doe!.nationalities).toEqual(['United Kingdom']);
    expect(doe!.ids).toEqual([
      { type: 'passport', value: 'GBR987654', country: 'United Kingdom' },
    ]);
  });

  it('prefixes program codes with EU.', () => {
    const entities = parseEu(xml);
    const putin = entities.find((e) => e.source_list_id === 'EU.13845.2014');
    expect(putin!.programs).toEqual(['EU.UKR.RUSSIA']);
  });

  it('captures designationDate as listed_on', () => {
    const entities = parseEu(xml);
    const putin = entities.find((e) => e.source_list_id === 'EU.13845.2014');
    expect(putin!.listed_on).toBe('2014-07-31');
  });

  it('returns empty array on empty XML', () => {
    expect(parseEu('<?xml version="1.0"?><export/>')).toEqual([]);
  });
});
