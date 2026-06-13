import { describe, it, expect } from 'vitest';
import { evaluateFlags, scoreFromFlags } from '../score.js';
import type { ScoreInputs } from '../score.js';

function baseInput(over: Partial<ScoreInputs> = {}): ScoreInputs {
  return {
    ico: '12345678',
    subject: {
      ico: '12345678',
      obchodniJmeno: 'Test Co.',
      datumVzniku: '2010-01-01',
    },
    vr: null,
    vatPayer: false,
    bankAccountsCount: 0,
    statutorySanctions: [],
    ...over,
  };
}

describe('evaluateFlags', () => {
  it('healthy company has zero flags', () => {
    const flags = evaluateFlags(baseInput());
    expect(flags).toEqual([]);
  });

  it('null subject from genuine 404 → NOT_FOUND_IN_ARES (high)', () => {
    const flags = evaluateFlags(baseInput({ subject: null }));
    expect(flags.find((f) => f.code === 'NOT_FOUND_IN_ARES')).toBeDefined();
    expect(flags.find((f) => f.code === 'ARES_UNAVAILABLE')).toBeUndefined();
  });

  it('null subject from ARES outage → ARES_UNAVAILABLE, NOT NOT_FOUND', () => {
    const flags = evaluateFlags(baseInput({ subject: null, aresUnavailable: true }));
    const av = flags.find((f) => f.code === 'ARES_UNAVAILABLE');
    expect(av).toBeDefined();
    expect(av!.weight).toBe(0); // availability gap, not a risk finding
    expect(flags.find((f) => f.code === 'NOT_FOUND_IN_ARES')).toBeUndefined();
  });

  it('triggers INSOLVENCY_ACTIVE on active proceeding', () => {
    const flags = evaluateFlags(baseInput({ insolvency: { has_active: true } }));
    expect(flags.find((f) => f.code === 'INSOLVENCY_ACTIVE')).toBeDefined();
    expect(flags[0]!.weight).toBe(50);
  });

  it('triggers COMPANY_SANCTIONED only at high confidence', () => {
    const lo = evaluateFlags(baseInput({
      companySanction: { entity: { id: 'x', source: 'ofac', primary_name: 'X', type: 'entity' }, confidence: 70, matched_on: 'primary_name' },
    }));
    expect(lo.find((f) => f.code === 'COMPANY_SANCTIONED')).toBeUndefined();

    const hi = evaluateFlags(baseInput({
      companySanction: { entity: { id: 'x', source: 'ofac', primary_name: 'X', type: 'entity' }, confidence: 90, matched_on: 'primary_name' },
    }));
    expect(hi.find((f) => f.code === 'COMPANY_SANCTIONED')).toBeDefined();
  });

  it('triggers STATUTORY_SANCTIONED for each high-confidence statutory match', () => {
    const flags = evaluateFlags(baseInput({
      statutorySanctions: [
        { name: 'Vladimir Putin', match: { entity: { id: 'eu:1', source: 'eu', primary_name: 'X', type: 'person' }, confidence: 95, matched_on: 'primary_name' } },
        { name: 'John Doe',       match: { entity: { id: 'eu:2', source: 'eu', primary_name: 'X', type: 'person' }, confidence: 70, matched_on: 'primary_name' } },
      ],
    }));
    const triggered = flags.filter((f) => f.code === 'STATUTORY_SANCTIONED');
    expect(triggered).toHaveLength(1);
    expect(triggered[0]!.description).toContain('Vladimir Putin');
  });

  it('flags dissolved company', () => {
    const flags = evaluateFlags(baseInput({
      subject: { ico: '12345678', obchodniJmeno: 'X', datumZaniku: '2020-01-01' },
    }));
    expect(flags.find((f) => f.code === 'COMPANY_DISSOLVED')).toBeDefined();
  });

  it('flags virtual address', () => {
    const flags = evaluateFlags(baseInput({ isVirtualAddress: true }));
    expect(flags.find((f) => f.code === 'VIRTUAL_ADDRESS')).toBeDefined();
  });

  it('flags recent statutory change (<30 days)', () => {
    const recent = new Date(Date.now() - 5 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    const flags = evaluateFlags(baseInput({ mostRecentStatutoryChange: recent }));
    expect(flags.find((f) => f.code === 'RECENT_STATUTORY_CHANGE')).toBeDefined();
  });

  it('does not flag old statutory change', () => {
    const old = new Date(Date.now() - 365 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    const flags = evaluateFlags(baseInput({ mostRecentStatutoryChange: old }));
    expect(flags.find((f) => f.code === 'RECENT_STATUTORY_CHANGE')).toBeUndefined();
  });

  it('flags new company (<6 months)', () => {
    const recent = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    const flags = evaluateFlags(baseInput({
      subject: { ico: '12345678', obchodniJmeno: 'New', datumVzniku: recent },
    }));
    expect(flags.find((f) => f.code === 'NEW_COMPANY')).toBeDefined();
  });

  it('flags VAT payer without bank account', () => {
    const flags = evaluateFlags(baseInput({ vatPayer: true, bankAccountsCount: 0 }));
    expect(flags.find((f) => f.code === 'NO_DPH_BANK_ACCOUNT')).toBeDefined();
  });

  it('does not flag VAT payer WITH bank account', () => {
    const flags = evaluateFlags(baseInput({ vatPayer: true, bankAccountsCount: 1 }));
    expect(flags.find((f) => f.code === 'NO_DPH_BANK_ACCOUNT')).toBeUndefined();
  });

  it('flags missing ARES record', () => {
    const flags = evaluateFlags(baseInput({ subject: null }));
    expect(flags.find((f) => f.code === 'NOT_FOUND_IN_ARES')).toBeDefined();
  });
});

describe('scoreFromFlags', () => {
  it('returns 0 / low for empty flags', () => {
    const s = scoreFromFlags([]);
    expect(s).toEqual({ value: 0, level: 'low' });
  });

  it('caps at 100', () => {
    const flags = [
      { code: 'A', severity: 'critical' as const, weight: 50, description: '', source: 'x' },
      { code: 'B', severity: 'critical' as const, weight: 50, description: '', source: 'x' },
      { code: 'C', severity: 'critical' as const, weight: 50, description: '', source: 'x' },
    ];
    const s = scoreFromFlags(flags);
    expect(s.value).toBe(100);
    expect(s.level).toBe('high');
  });

  it('classifies bands by sum when no critical flags', () => {
    expect(scoreFromFlags([{ code: 'X', severity: 'low', weight: 10, description: '', source: '' }]).level).toBe('low');
    expect(scoreFromFlags([{ code: 'X', severity: 'medium', weight: 30, description: '', source: '' }]).level).toBe('medium');
    expect(scoreFromFlags([{ code: 'X', severity: 'high', weight: 60, description: '', source: '' }]).level).toBe('high');
  });

  it('triggers STATUTORY_REGISTERED_AT_GOVT_OFFICE for úřad bydliště', () => {
    const flags = evaluateFlags(baseInput({
      statutoryGovtAddresses: [{ name: 'Jan Novák', signal: 'marker', matched_token: 'úřad' }],
    }));
    const f = flags.find((x) => x.code === 'STATUTORY_REGISTERED_AT_GOVT_OFFICE');
    expect(f).toBeDefined();
    expect(f!.weight).toBe(25);
    expect(f!.severity).toBe('high');
  });

  it('triggers STATUTORY_PRIOR_BANKRUPT_COMPANY for surname match on insolvent firm', () => {
    const flags = evaluateFlags(baseInput({
      statutoryPriorBankruptcies: [
        { name: 'Pavel Novák', ico: '99999999', company_name: 'Old Co.', spisova_znacka: 'KSPH 60 INS 1/2024' },
      ],
    }));
    const f = flags.find((x) => x.code === 'STATUTORY_PRIOR_BANKRUPT_COMPANY');
    expect(f).toBeDefined();
    expect(f!.weight).toBe(20);
  });

  it('any critical flag forces high regardless of weight', () => {
    expect(scoreFromFlags([{ code: 'X', severity: 'critical', weight: 5, description: '', source: '' }]).level).toBe('high');
    expect(scoreFromFlags([{ code: 'X', severity: 'critical', weight: 50, description: '', source: '' }]).level).toBe('high');
  });
});
