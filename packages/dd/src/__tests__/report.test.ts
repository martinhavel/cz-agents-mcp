import { afterEach, describe, it, expect, vi } from 'vitest';
import { buildReport } from '../report.js';
import * as ownershipNetwork from '../ownership-network.js';
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

function mockUnavailableIsir(): IsirLike {
  return {
    checkActiveInsolvency: async () => {
      throw new Error('ISIR unavailable');
    },
  };
}

describe('buildReport', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

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
            fyzickaOsoba: { jmeno: 'Vladimir', prijmeni: 'Putin', datumNarozeni: '1952-10-07' },
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
        entity: {
          id: 'eu:putin',
          source: 'eu',
          primary_name: 'Vladimir Vladimirovich Putin',
          type: 'person',
          aliases: ['Vladimir Putin'],
          dobs: ['1952-10-07'],
          nationalities: ['Russia'],
          programs: ['EU.RUSSIA'],
          listed_on: '2014-07-31',
        },
        confidence: 100,
        matched_on: 'alias',
        matched_alias: 'Vladimir Putin',
      }],
      'ico:12345678': [],
    });

    const report = await buildReport('12345678', { ares, sanctions });
    expect(report.statutory_body).toHaveLength(2);
    const putin = report.statutory_body.find((m) => m.name === 'Vladimir Putin');
    expect(putin?.sanctions_match?.confidence).toBe(100);
    expect(putin?.sanctions_match).toMatchObject({
      primary_name: 'Vladimir Vladimirovich Putin',
      matched_alias: 'Vladimir Putin',
      list_dobs: ['1952-10-07'],
      subject_dob: '1952-10-07',
      dob_status: 'match',
      match_strength: 'strong',
      nationalities: ['Russia'],
      programs: ['EU.RUSSIA'],
      listed_on: '2014-07-31',
    });
    expect(report.sanctions.any_statutory_match).toBe(true);
    expect(report.red_flags.find((f) => f.code === 'STATUTORY_SANCTIONED')).toBeDefined();
    expect(report.risk_score.level).toBe('high');
  });

  it('falls back to jednatel from s.r.o. statutory organ name', async () => {
    const ares = mockAres({
      subject: { ico: '12345679', obchodniJmeno: 'Test Co. s.r.o.' },
      vr: {
        ico: '12345679',
        statutarniOrgany: [{
          nazevOrganu: 'Jednatelé',
          clenoveOrganu: [{
            fyzickaOsoba: { jmeno: 'Jan', prijmeni: 'Test' },
            datumZapisu: '2024-01-01',
          }],
        }],
      },
    });

    const report = await buildReport('12345679', { ares });

    expect(report.statutory_body[0]?.role).toBe('jednatel');
  });

  it('falls back to předseda představenstva from a.s. statutory organ name', async () => {
    const ares = mockAres({
      subject: { ico: '12345679', obchodniJmeno: 'Test Co. s.r.o.' },
      vr: {
        ico: '12345679',
        statutarniOrgany: [{
          nazevOrganu: 'Předseda představenstva',
          clenoveOrganu: [{
            fyzickaOsoba: { jmeno: 'Jana', prijmeni: 'Testová' },
            datumZapisu: '2024-01-01',
          }],
        }],
      },
    });

    const report = await buildReport('12345679', { ares });

    expect(report.statutory_body[0]?.role).toBe('předseda představenstva');
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
    expect(report.sanctions.company_match).toMatchObject({
      primary_name: 'Bank Rossiya',
      dob_status: 'subject_missing',
      match_strength: 'strong',
    });
    expect(report.red_flags.find((f) => f.code === 'COMPANY_SANCTIONED')).toBeDefined();
    expect(report.risk_score.level).toBe('high');
  });

  it('summarizes name matches when the sanctions list has no DOB', async () => {
    const ares = mockAres({
      subject: { ico: '12345678', obchodniJmeno: 'Test Co.' },
      vr: {
        ico: '12345678',
        statutarniOrgany: [{
          nazevOrganu: 'Jednatelé',
          clenoveOrganu: [{
            fyzickaOsoba: { jmeno: 'John', prijmeni: 'Doe', datumNarozeni: '1970-01-01' },
            funkce: { nazev: 'jednatel' },
          }],
        }],
      },
    });
    const sanctions = mockSanctions({
      'name:John Doe': [{
        entity: { id: 'eu:john-doe', source: 'eu', primary_name: 'John Doe', type: 'person' },
        confidence: 96,
        matched_on: 'primary_name',
      }],
    });

    const report = await buildReport('12345678', { ares, sanctions });
    expect(report.statutory_body[0]?.sanctions_match).toMatchObject({
      primary_name: 'John Doe',
      subject_dob: '1970-01-01',
      dob_status: 'list_missing',
      match_strength: 'possible',
    });
  });

  it('summarizes name matches when ARES has no subject DOB', async () => {
    const ares = mockAres({
      subject: { ico: '12345678', obchodniJmeno: 'Test Co.' },
      vr: {
        ico: '12345678',
        statutarniOrgany: [{
          nazevOrganu: 'Předseda představenstva',
          clenoveOrganu: [{
            fyzickaOsoba: { jmeno: 'Jane', prijmeni: 'Doe' },
            funkce: { nazev: 'předseda představenstva' },
          }],
        }],
      },
    });
    const sanctions = mockSanctions({
      'name:Jane Doe': [{
        entity: {
          id: 'eu:jane-doe',
          source: 'eu',
          primary_name: 'Jane Doe',
          type: 'person',
          dobs: ['1980-05-05'],
        },
        confidence: 94,
        matched_on: 'primary_name',
      }],
    });

    const report = await buildReport('12345678', { ares, sanctions });
    expect(report.statutory_body[0]?.sanctions_match).toMatchObject({
      primary_name: 'Jane Doe',
      list_dobs: ['1980-05-05'],
      dob_status: 'subject_missing',
      match_strength: 'possible',
    });
    expect(report.statutory_body[0]?.sanctions_match?.subject_dob).toBeUndefined();
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

  it('does not map ISIR errors to inactive insolvency', async () => {
    const ares = mockAres({
      subject: { ico: '12345679', obchodniJmeno: 'Test Co. s.r.o.' },
    });

    const report = await buildReport('12345679', { ares, isir: mockUnavailableIsir() }, { depth: 'full' });

    expect(report.insolvency).toEqual({ checked: false, error: 'isir_unavailable' });
    expect(report.insolvency?.has_active_proceeding).toBeUndefined();
    expect(report.red_flags.find((f) => f.code === 'INSOLVENCY_ACTIVE')).toBeUndefined();
  });

  it('ARES outage degrades to ARES_UNAVAILABLE (NOT a NOT_FOUND verdict)', async () => {
    // getByIco THROWS (outage) — must be distinguished from a genuine 404.
    // Reporting NOT_FOUND_IN_ARES here would be a false "this IČO does not
    // exist" verdict derived from an unreachable upstream.
    const ares: AresLike = {
      getByIco: async () => { throw new Error('ARES timeout'); },
      getBankAccounts: async () => { throw new Error('boom'); },
      getVrRecord: async () => { throw new Error('boom'); },
      search: async () => { throw new Error('boom'); },
    };
    const report = await buildReport('12345678', { ares });
    expect(report.company.found).toBe(false);
    expect(report.company.checked).toBe(false);
    expect(report.company.error).toBe('ares_unavailable');
    expect(report.red_flags.find((f) => f.code === 'ARES_UNAVAILABLE')).toBeDefined();
    expect(report.red_flags.find((f) => f.code === 'NOT_FOUND_IN_ARES')).toBeUndefined();
  });

  it('genuine ARES 404 (null subject, no throw) still flags NOT_FOUND_IN_ARES', async () => {
    const ares = mockAres({ subject: null });
    const report = await buildReport('00000000', { ares });
    expect(report.company.found).toBe(false);
    expect(report.company.error).toBeUndefined();
    expect(report.red_flags.find((f) => f.code === 'NOT_FOUND_IN_ARES')).toBeDefined();
    expect(report.red_flags.find((f) => f.code === 'ARES_UNAVAILABLE')).toBeUndefined();
  });

  it('adds ownership-network teaser from non-empty summary', async () => {
    vi.spyOn(ownershipNetwork, 'getOwnershipNetwork').mockResolvedValueOnce({
      ico: '12345678',
      network_size: 7,
      shared_role_link_count: 2,
      coverage_pct: 0.83,
      as_of: '2026-06-21',
      _teaser: true,
    });

    const report = await buildReport('12345678', {
      ares: mockAres({ subject: { ico: '12345678', obchodniJmeno: 'Network Co.' } }),
    });

    expect(ownershipNetwork.getOwnershipNetwork).toHaveBeenCalledWith('12345678', { level: 'summary' });
    expect(report.ownership_network_teaser).toMatchObject({
      title: 'Vlastnická a personální síť (z veřejného VR)',
      network_size: 7,
      shared_role_link_count: 2,
      coverage_pct: 0.83,
      as_of: '2026-06-21',
      upgrade_hint: 'Pro plnou síť a signály přejděte na vyšší tarif.',
    });
    expect(report.ownership_network_teaser.text).toBeUndefined();
  });

  it('degrades ownership-network teaser when summary table is empty', async () => {
    vi.spyOn(ownershipNetwork, 'getOwnershipNetwork').mockRejectedValueOnce(new Error('vr_base_client_unavailable'));

    const report = await buildReport('12345678', {
      ares: mockAres({ subject: { ico: '12345678', obchodniJmeno: 'Preparing Co.' } }),
    });

    expect(report.ownership_network_teaser.network_size).toBe(0);
    expect(report.ownership_network_teaser.coverage_pct).toBe(0);
    expect(report.ownership_network_teaser.as_of).toBeNull();
    expect(report.ownership_network_teaser.text).toContain('připravuje');
  });

  it('adds static ESM onramp block', async () => {
    const report = await buildReport('12345678', {
      ares: mockAres({ subject: { ico: '12345678', obchodniJmeno: 'ESM Co.' } }),
    });

    expect(report.esm_onramp.title).toBe('Skutečný majitel (ESM)');
    expect(report.esm_onramp.link).toBe('https://esm.justice.cz');
    expect(JSON.stringify(report.esm_onramp)).toContain('esm.justice.cz');
    expect(report.esm_onramp.separation.dolozeny_ubo).toContain('klient sám získá z ESM');
    expect(report.esm_onramp.separation.indikovana_struktura).toContain('VR odhad');
  });

  it('does not expose paid ownership risk labels in free report output', async () => {
    const report = await buildReport('12345678', {
      ares: mockAres({ subject: { ico: '12345678', obchodniJmeno: 'Free Co.' } }),
    });

    const freeOutput = JSON.stringify(report).toLowerCase();
    expect(freeOutput).not.toContain('nominee');
    expect(freeOutput).not.toContain('phoenix');
    expect(freeOutput).not.toContain('risk_label');
  });
});
