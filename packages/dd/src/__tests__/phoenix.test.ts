import { describe, it, expect } from 'vitest';
import { detectPhoenix } from '../patterns/phoenix.js';
import type { DdReport, StatutoryMember } from '../types.js';

function baseReport(overrides: Partial<DdReport> = {}): DdReport {
  return {
    ico: '12345678',
    retrieved_at: '2026-05-10T10:00:00Z',
    basic_only: false,
    company: { found: true, name: 'Acme Nová s.r.o.', address: 'Praha 1, Testovní 1' },
    vat: { is_payer: false, bank_accounts: [] },
    statutory_body: [],
    sanctions: { any_statutory_match: false },
    red_flags: [],
    risk_score: { value: 0, level: 'low' },
    ...overrides,
  };
}

function fakePerson(
  name: string,
  extra: Partial<StatutoryMember> = {},
): StatutoryMember {
  return {
    name,
    role: 'jednatel',
    is_person: true,
    ...extra,
  };
}

describe('detectPhoenix — basic variant (3 indicators)', () => {
  it('clean company — all indicators false, riskScore=0', () => {
    const report = baseReport({
      statutory_body: [fakePerson('Jana Novotná')],
      company: { found: true, name: 'Acme Nová s.r.o.', nace_codes: ['62.01'] },
    });
    const result = detectPhoenix(report);

    expect(result.total).toBe(3);
    expect(result.fired).toBe(0);
    expect(result.riskScore).toBe(0);
    expect(result.indicators.every((i) => !i.fired)).toBe(true);
  });

  it('SURNAME_MATCH fires when statutory member has prior bankrupt companies', () => {
    const report = baseReport({
      statutory_body: [
        fakePerson('Pavel Zkrachovalý', {
          prior_bankrupt_companies: [
            { ico: '99999991', name: 'Acme Insolventní s.r.o.', spisova_znacka: 'INS 100/2023' },
          ],
        }),
      ],
    });
    const result = detectPhoenix(report);

    const ind = result.indicators.find((i) => i.code === 'SURNAME_MATCH')!;
    expect(ind.fired).toBe(true);
    expect(ind.available).toBe(true);
    expect(ind.members).toContain('Pavel Zkrachovalý');
    expect(ind.detail).toContain('99999991');
    expect(result.riskScore).toBeGreaterThan(0);
  });

  it('SURNAME_MATCH unavailable when no persons in statutory body', () => {
    const report = baseReport({
      statutory_body: [
        { name: 'Holding Správa a.s.', role: 'jednatel', is_person: false },
      ],
    });
    const result = detectPhoenix(report);

    const ind = result.indicators.find((i) => i.code === 'SURNAME_MATCH')!;
    expect(ind.fired).toBe(false);
    expect(ind.available).toBe(false);
    expect(result.unavailable).toContain('SURNAME_MATCH');
  });

  it('FOUNDING_PROXIMITY fires when company founded within 12 months of insolvency start', () => {
    // Company founded 6 months after insolvency start
    const insolStart = new Date('2023-01-15');
    const foundedOn = new Date('2023-07-20');

    const report = baseReport({
      company: {
        found: true,
        name: 'Nástupce Insolventní s.r.o.',
        registered_on: foundedOn.toISOString().slice(0, 10),
      },
      insolvency: {
        has_active_proceeding: true,
        started_on: insolStart.toISOString().slice(0, 10),
        spisova_znacka: 'INS 500/2023',
      },
    });
    const result = detectPhoenix(report);

    const ind = result.indicators.find((i) => i.code === 'FOUNDING_PROXIMITY')!;
    expect(ind.fired).toBe(true);
    expect(ind.available).toBe(true);
    expect(ind.detail).toContain('phoenix pattern');
    // Founded AFTER insolvency start ⇒ "po zahájení insolvence" (was reversed).
    expect(ind.detail).toContain('po zahájení insolvence');
    expect(ind.detail).not.toContain('před zahájením insolvence');
  });

  it('FOUNDING_PROXIMITY labels a company founded BEFORE insolvency start correctly', () => {
    // Company founded 6 months before insolvency start.
    const foundedOn = new Date('2023-01-15');
    const insolStart = new Date('2023-07-20');

    const report = baseReport({
      company: {
        found: true,
        name: 'Předchůdce s.r.o.',
        registered_on: foundedOn.toISOString().slice(0, 10),
      },
      insolvency: {
        has_active_proceeding: true,
        started_on: insolStart.toISOString().slice(0, 10),
        spisova_znacka: 'INS 600/2023',
      },
    });
    const ind = detectPhoenix(report).indicators.find((i) => i.code === 'FOUNDING_PROXIMITY')!;
    expect(ind.fired).toBe(true);
    expect(ind.detail).toContain('před zahájením insolvence');
    expect(ind.detail).not.toContain('po zahájení insolvence');
  });

  it('FOUNDING_PROXIMITY does not fire when gap exceeds 12 months', () => {
    const insolStart = new Date('2020-01-01');
    const foundedOn = new Date('2024-06-01');

    const report = baseReport({
      company: {
        found: true,
        name: 'Pozdní Nástupce s.r.o.',
        registered_on: foundedOn.toISOString().slice(0, 10),
      },
      insolvency: {
        has_active_proceeding: true,
        started_on: insolStart.toISOString().slice(0, 10),
      },
    });
    const result = detectPhoenix(report);

    const ind = result.indicators.find((i) => i.code === 'FOUNDING_PROXIMITY')!;
    expect(ind.fired).toBe(false);
  });

  it('NACE_MATCH returns informational (not fired) when priors exist but cross-lookup needed', () => {
    const report = baseReport({
      company: {
        found: true,
        name: 'Acme Nástupce s.r.o.',
        nace_codes: ['47.11', '47.19'],
      },
      statutory_body: [
        fakePerson('Radek Insolventní', {
          prior_bankrupt_companies: [{ ico: '88888881', name: 'Acme Původní s.r.o.' }],
        }),
      ],
    });
    const result = detectPhoenix(report);

    const ind = result.indicators.find((i) => i.code === 'NACE_MATCH')!;
    expect(ind.fired).toBe(false);
    expect(ind.available).toBe(true);
    expect(ind.detail).toContain('cross-ARES');
  });

  it('multiple indicators fire — riskScore reflects cumulative weights', () => {
    const insolStart = new Date('2024-01-10');
    const foundedOn = new Date('2024-05-01');

    const report = baseReport({
      company: {
        found: true,
        name: 'Phoenix Reinkarnovaný s.r.o.',
        registered_on: foundedOn.toISOString().slice(0, 10),
        nace_codes: ['62.01'],
      },
      statutory_body: [
        fakePerson('Tomáš Opakující', {
          prior_bankrupt_companies: [
            { ico: '77777771', name: 'Acme Insolventní s.r.o.' },
            { ico: '77777772', name: 'Beta Zkrachovaná s.r.o.' },
          ],
        }),
      ],
      insolvency: {
        has_active_proceeding: true,
        started_on: insolStart.toISOString().slice(0, 10),
        spisova_znacka: 'INS 999/2024',
      },
    });
    const result = detectPhoenix(report);

    // SURNAME_MATCH (40) + FOUNDING_PROXIMITY (35) = 75
    expect(result.riskScore).toBe(75);
    expect(result.fired).toBe(2);
    expect(result.unavailable).toHaveLength(0);
  });
});
