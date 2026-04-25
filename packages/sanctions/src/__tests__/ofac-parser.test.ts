import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { parseOfac } from '../fetchers/ofac.js';

const here = dirname(fileURLToPath(import.meta.url));
const xml = readFileSync(join(here, 'fixtures/ofac-sample.xml'), 'utf8');

describe('parseOfac', () => {
  it('parses 3 entries', () => {
    expect(parseOfac(xml)).toHaveLength(3);
  });

  it('namespaces ids with ofac:', () => {
    const entities = parseOfac(xml);
    expect(entities.map((e) => e.id)).toEqual([
      'ofac:12345',
      'ofac:67890',
      'ofac:55555',
    ]);
  });

  it('classifies sdnType correctly', () => {
    const entities = parseOfac(xml);
    expect(entities.find((e) => e.source_list_id === '12345')!.type).toBe('person');
    expect(entities.find((e) => e.source_list_id === '67890')!.type).toBe('entity');
    expect(entities.find((e) => e.source_list_id === '55555')!.type).toBe('vessel');
  });

  it('joins firstName + lastName for primary_name', () => {
    const entities = parseOfac(xml);
    expect(entities.find((e) => e.source_list_id === '12345')!.primary_name).toBe('Vladimir Putin');
  });

  it('captures akas as aliases', () => {
    const entities = parseOfac(xml);
    const putin = entities.find((e) => e.source_list_id === '12345')!;
    expect(putin.aliases).toContain('Vladimir Vladimirovich Putin');
  });

  it('prefixes programs with OFAC.', () => {
    const entities = parseOfac(xml);
    const bank = entities.find((e) => e.source_list_id === '67890')!;
    expect(bank.programs).toEqual(['OFAC.RUSSIA-EO14024', 'OFAC.UKRAINE-EO13662']);
  });

  it('captures ids when present', () => {
    const entities = parseOfac(xml);
    const bank = entities.find((e) => e.source_list_id === '67890')!;
    expect(bank.ids).toEqual([
      { type: 'Tax ID No.', value: '7831000122', country: 'Russia' },
    ]);
  });

  it('returns empty array on empty list', () => {
    expect(parseOfac('<?xml version="1.0"?><sdnList/>')).toEqual([]);
  });
});
