import { describe, it, expect } from 'vitest';
import { buildReport } from '../report.js';
import type {
  AresLike,
  AresSubjectLike,
  AresVrLike,
  AresBankAccountLike,
  AresSearchResultLike,
  SanctionsLike,
  SanctionsMatch,
  IsirLike,
} from '../clients.js';

interface MockAresOpts {
  subject?: AresSubjectLike | null;
  vr?: AresVrLike | null;
  bank?: AresBankAccountLike[];
  searchTotal?: number;
}

function mockAres(opts: MockAresOpts = {}): AresLike {
  return {
    getByIco: async () => opts.subject ?? null,
    getBankAccounts: async () => opts.bank ?? [],
    getVrRecord: async () => opts.vr ?? null,
    search: async (): Promise<AresSearchResultLike> => ({
      pocetCelkem: opts.searchTotal ?? 0,
      ekonomickeSubjekty: [],
    }),
  };
}

function mockSanctions(matches: Record<string, SanctionsMatch[]> = {}): SanctionsLike {
  return {
    searchByName: (name) => matches[`name:${name}`] ?? [],
    searchByIco: (ico) => matches[`ico:${ico}`] ?? [],
  };
}

function mockIsir(active: boolean): IsirLike {
  return {
    checkActiveInsolvency: async () => ({
      has_active: active,
      spisova_znacka: active ? 'KSPH 60 INS 999/2025' : undefined,
    }),
  };
}

describe('buildReport', () => {
  it('builds basic report from ARES alone (no sanctions client)', async () => {
    const ares = mockAres({
      subject: {
        ico: '12345678',
        obchodniJmeno: 'Test Co.',
        dic: 'CZ12345678',
        sidlo: { textovaAdresa: 'Praha 1, Národní 100' },
        pravniForma: 's.r.o.',
        datumVzniku: '2010-01-01',
        czNace: ['62.01'],
        financniUrad: 'FÚ Praha 1',
      },
      bank: [{ cisloUctu: '123456', kodBanky: '0100', menaUctu: 'CZK' }],
    });

    const report = await buildReport('12345678', { ares });
    expect(report.ico).toBe('12345678');
    expect(report.basic_only).toBe(true);
    expect(report.company.found).toBe(true);
    expect(report.company.name).toBe('Test Co.');
    expect(report.vat.is_payer).toBe(true);
    expect(report.vat.bank_accounts).toEqual(['123456/0100']);
    expect(report.statutory_body).toEqual([]);
    expect(report.sanctions.any_statutory_match).toBe(false);
    expect(report.risk_score.level).toBe('low');
  });

  it('flags missing ARES record', async () => {
    const ares = mockAres({ subject: null });
    const report = await buildReport('99999999', { ares });
    expect(report.company.found).toBe(false);
    expect(report.red_flags.find((f) => f.code === 'NOT_FOUND_IN_ARES')).toBeDefined();
    expect(report.risk_score.value).toBeGreaterThanOrEqual(30);
  });

  it('extracts statutory body from VR and screens against sanctions', async () => {
    const ares = mockAres({
      subject: { ico: '12345678', obchodniJmeno: 'Bad Co.', dic: 'CZ12345678' },
      bank: [{ cisloUctu: '1', kodBanky: '0100' }],
      vr: {
        ico: '12345678',
        statutarniOrgany: [{
          nazevOrganu: 'Jednatelé',
          clenoveOrganu: [{
            fyzickaOsoba: { jmeno: 'Vladimir', prijmeni: 'Putin' },
            funkce: { nazev: 'jednatel' },
            datumZapisu: '2024-01-01',
          }, {
            fyzickaOsoba: { jmeno: 'Jane', prijmeni: 'Doe' },
            funkce: { nazev: 'jednatel' },
            datumZapisu: '2024-01-01',
          }],
        }],
      },
    });

    const sanctions = mockSanctions({
      'name:Vladimir Putin': [{
        entity: { id: 'eu:putin', source: 'eu', primary_name: 'Vladimir Putin', type: 'person' },
        confidence: 100,
        matched_on: 'primary_name',
      }],
      'ico:12345678': [],
    });

    const report = await buildReport('12345678', { ares, sanctions });
    expect(report.statutory_body).toHaveLength(2);
    const putin = report.statutory_body.find((m) => m.name === 'Vladimir Putin');
    expect(putin?.sanctions_match?.confidence).toBe(100);
    expect(report.sanctions.any_statutory_match).toBe(true);
    expect(report.red_flags.find((f) => f.code === 'STATUTORY_SANCTIONED')).toBeDefined();
    expect(report.risk_score.level).toBe('high');
  });

  it('flags directly-sanctioned company via IČO', async () => {
    const ares = mockAres({
      subject: { ico: '12345678', obchodniJmeno: 'Bank Rossiya', dic: 'CZ12345678' },
      bank: [{ cisloUctu: '1', kodBanky: '0100' }],
    });
    const sanctions = mockSanctions({
      'ico:12345678': [{
        entity: { id: 'eu:bank', source: 'eu', primary_name: 'Bank Rossiya', type: 'entity' },
        confidence: 100,
        matched_on: 'ico',
      }],
    });
    const report = await buildReport('12345678', { ares, sanctions });
    expect(report.sanctions.company_match?.confidence).toBe(100);
    expect(report.red_flags.find((f) => f.code === 'COMPANY_SANCTIONED')).toBeDefined();
    expect(report.risk_score.level).toBe('high');
  });

  it('full depth includes ISIR + virtual address probe', async () => {
    const ares: AresLike = {
      getByIco: async () => ({
        ico: '12345678',
        obchodniJmeno: 'Shell Co.',
        sidlo: { nazevObce: 'Praha', nazevUlice: 'Národní', psc: 11000, textovaAdresa: 'Praha 1, Národní 1' },
      }),
      getBankAccounts: async () => [],
      getVrRecord: async () => null,
      search: async () => ({ pocetCelkem: 75, ekonomickeSubjekty: [] }),
    };
    const isir = mockIsir(true);
    const report = await buildReport('12345678', { ares, isir }, { depth: 'full' });

    expect(report.basic_only).toBe(false);
    expect(report.insolvency?.has_active_proceeding).toBe(true);
    expect(report.red_flags.find((f) => f.code === 'INSOLVENCY_ACTIVE')).toBeDefined();
    expect(report.red_flags.find((f) => f.code === 'VIRTUAL_ADDRESS')).toBeDefined();
  });

  it('basic depth skips ISIR + virtual address probes', async () => {
    const ares = mockAres({
      subject: { ico: '12345678', obchodniJmeno: 'Test', sidlo: { nazevObce: 'Praha', nazevUlice: 'Národní', psc: 11000 } },
    });
    const isir = mockIsir(true);
    const report = await buildReport('12345678', { ares, isir }, { depth: 'basic' });
    expect(report.basic_only).toBe(true);
    expect(report.insolvency).toBeUndefined();
    expect(report.red_flags.find((f) => f.code === 'INSOLVENCY_ACTIVE')).toBeUndefined();
  });

  it('survives ARES errors gracefully (degrades, does not throw)', async () => {
    const ares: AresLike = {
      getByIco: async () => { throw new Error('ARES timeout'); },
      getBankAccounts: async () => { throw new Error('boom'); },
      getVrRecord: async () => { throw new Error('boom'); },
      search: async () => { throw new Error('boom'); },
    };
    const report = await buildReport('12345678', { ares });
    expect(report.company.found).toBe(false);
    expect(report.red_flags.find((f) => f.code === 'NOT_FOUND_IN_ARES')).toBeDefined();
  });
});
