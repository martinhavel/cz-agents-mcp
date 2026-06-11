import { describe, it, expect } from 'vitest';
import { resolveLegalForm } from '@czagents/shared';
import { buildDdSummaryMarkdown, buildRiskScoreSummaryMarkdown } from '../summary.js';
import type { DdReport, RedFlag } from '../types.js';

const NOW = '2026-06-11T18:00:00.000Z';

function report(overrides: Partial<DdReport> = {}): DdReport {
  return {
    ico: '12345679',
    retrieved_at: NOW,
    basic_only: false,
    company: {
      name: 'Test Co. s.r.o.',
      legal_form: '112',
      address: 'Testovací 1, Praha',
      registered_on: '2010-01-01',
      found: true,
    },
    vat: {
      is_payer: true,
      dic: 'CZ12345679',
      bank_accounts: ['123/0100'],
      reliability: 'NE',
    },
    statutory_body: [{ name: 'Jan Test', role: 'jednatel', is_person: true }],
    insolvency: { has_active_proceeding: false, note: 'No record found' },
    sanctions: { any_statutory_match: false },
    red_flags: [],
    risk_score: { value: 0, level: 'low' },
    ...overrides,
  };
}

function flag(overrides: Partial<RedFlag>): RedFlag {
  return {
    code: 'X',
    severity: 'medium',
    weight: 10,
    description: 'Testovací nález.',
    source: 'ares',
    ...overrides,
  };
}

describe('summary markdown', () => {
  it('renders clean full report', () => {
    const text = buildDdSummaryMarkdown(report());
    expect(text).toContain('✅ ČISTÉ');
    expect(text).toContain('Insolvence: bez insolvence');
    expect(text).toContain('s.r.o.');
    expect(text).toContain('Žádné nálezy v prověřených zdrojích.');
    expect(text).not.toContain('NACE');
  });

  it('renders clean basic report with full-depth insolvency hint', () => {
    const text = buildDdSummaryMarkdown(report({ basic_only: true, insolvency: undefined }));
    expect(text).toContain("Insolvence neprověřena (depth:'full' zdarma)");
  });

  it('renders active insolvency as red risk', () => {
    const text = buildDdSummaryMarkdown(report({
      insolvency: { has_active_proceeding: true, spisova_znacka: 'KSPH 60 INS 999/2025' },
      red_flags: [flag({ code: 'INSOLVENCY_ACTIVE', severity: 'critical', weight: 50, description: 'Aktivní insolvenční řízení v ISIR.', source: 'isir' })],
      risk_score: { value: 50, level: 'high' },
    }));
    expect(text).toContain('🔴 RIZIKO');
    expect(text).toContain('Insolvence: aktivní');
    expect(text).toContain('Blokující.');
  });

  it('renders medium risk verdict and gloss', () => {
    const text = buildDdSummaryMarkdown(report({
      red_flags: [flag({ severity: 'medium', weight: 10 })],
      risk_score: { value: 30, level: 'medium' },
    }));
    expect(text).toContain('⚠ POZOR');
    expect(text).toContain('Prověřit.');
  });

  it('renders ISIR unavailable as unverified, not no insolvency', () => {
    const text = buildDdSummaryMarkdown(report({
      insolvency: { checked: false, error: 'isir_unavailable' },
    }));
    expect(text).toContain('ISIR nedostupný — insolvence neověřena');
    expect(text).not.toContain('Insolvence: bez insolvence');
  });

  it('renders not found report', () => {
    const text = buildDdSummaryMarkdown(report({
      company: { found: false },
      red_flags: [flag({ code: 'NOT_FOUND_IN_ARES', severity: 'high', weight: 30, description: 'IČO nenalezeno v ARES.', source: 'ares' })],
      risk_score: { value: 30, level: 'medium' },
    }));
    expect(text).toContain('**Nenalezeno**');
    expect(text).toContain('IČO nenalezeno v ARES.');
  });

  it('renders zero statutory members', () => {
    const text = buildDdSummaryMarkdown(report({ statutory_body: [] }));
    expect(text).toContain('Statutární orgán: 0 osob · bez statutárů');
    expect(text).toContain('bez sankcí (0/0 statutárů)');
  });

  it('resolves legal form known, unknown, and non-numeric values', () => {
    expect(resolveLegalForm('112')).toBe('s.r.o.');
    expect(resolveLegalForm('999')).toBe('999');
    expect(resolveLegalForm('spolek')).toBe('spolek');
  });

  it('renders risk-score summary without paid teaser', () => {
    const text = buildRiskScoreSummaryMarkdown({
      ico: '12345679',
      company_name: 'Test Co. s.r.o.',
      value: 30,
      level: 'medium',
      top_flags: [flag({ severity: 'medium', description: 'Adresa registrovaná u 50+ firem.' })],
      retrieved_at: NOW,
    });
    expect(text).toContain('⚠ POZOR');
    expect(text).toContain('Adresa registrovaná u 50+ firem.');
    expect(text).toContain('*Snapshot 2026-06-11T18:00:00.000Z · cz-agents.dev*');
    expect(text).not.toContain('placená úroveň');
  });
});
