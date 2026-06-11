import { describe, it, expect, vi, afterEach } from 'vitest';
import { resolveLegalForm } from '@czagents/shared';
import { buildDdSummaryMarkdown, buildRiskScoreSummaryMarkdown } from '../summary.js';
import { buildDdServer } from '../server.js';
import { buildReport } from '../report.js';
import type { DdReport, RedFlag } from '../types.js';
import type { AresLike } from '../clients.js';

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

  it('resolves legal form known, numeric-in-codebook, unknown, and non-numeric values', () => {
    expect(resolveLegalForm('112')).toBe('s.r.o.');
    expect(resolveLegalForm('999')).toBe('Ostatní');
    expect(resolveLegalForm('998')).toBe('998'); // truly unknown
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

  it('returns summary first and byte-stable raw JSON second from get_dd_report', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(NOW));
    try {
      const ares = mockAres();
      const expected = await buildReport('12345679', { ares }, { depth: 'basic' });
      const server = buildDdServer({ ares });
      const tool = (server as unknown as { _registeredTools: Record<string, { handler: (args: unknown, extra?: unknown) => Promise<{ content: Array<{ text: string }> }> }> })
        ._registeredTools.get_dd_report;

      const response = await tool.handler({ ico: '12345679', depth: 'basic' }, { sessionId: 'summary-contract' });

      expect(response.content[0]?.text.startsWith('**')).toBe(true);
      expect(JSON.parse(response.content[1]!.text)).toEqual(expected);
      expect(response.content[1]?.text).toBe(JSON.stringify(expected, null, 2));
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('verdict degradation — unavailable sources', () => {
  it('ISIR down + otherwise clean → ⚠ ČÁSTEČNĚ PROVĚŘENO, not ✅', () => {
    const text = buildDdSummaryMarkdown(report({
      insolvency: { checked: false, error: 'isir_unavailable' },
      risk_score: { value: 0, level: 'low' },
    }));
    expect(text).toContain('⚠ ČÁSTEČNĚ PROVĚŘENO');
    expect(text).not.toContain('✅');
    expect(text).toContain('ISIR nedostupný');
  });

  it('sanctions down + otherwise clean → ⚠ ČÁSTEČNĚ PROVĚŘENO, not "bez sankcí"', () => {
    const text = buildDdSummaryMarkdown(report({
      sanctions: { any_statutory_match: false, checked: false, error: 'sanctions_unavailable' },
      risk_score: { value: 0, level: 'low' },
    }));
    expect(text).toContain('⚠ ČÁSTEČNĚ PROVĚŘENO');
    expect(text).not.toContain('✅');
    expect(text).toContain('sankce neprověřeny');
    expect(text).not.toContain('bez sankcí');
  });

  it('ADIS down + otherwise clean → ⚠ ČÁSTEČNĚ PROVĚŘENO, not ✅', () => {
    const text = buildDdSummaryMarkdown(report({
      vat: { is_payer: false, bank_accounts: [], checked: false, error: 'adis_unavailable' },
      risk_score: { value: 0, level: 'low' },
    }));
    expect(text).toContain('⚠ ČÁSTEČNĚ PROVĚŘENO');
    expect(text).not.toContain('✅');
    expect(text).toContain('ADIS nedostupný');
  });

  it('critical flag + source down → 🔴 RIZIKO wins over ⚠ ČÁSTEČNĚ', () => {
    const text = buildDdSummaryMarkdown(report({
      insolvency: { checked: false, error: 'isir_unavailable' },
      red_flags: [flag({ code: 'INSOLVENCY_ACTIVE', severity: 'critical', weight: 50, description: 'Aktivní insolvenční řízení.', source: 'isir' })],
      risk_score: { value: 50, level: 'high' },
    }));
    expect(text).toContain('🔴 RIZIKO');
    expect(text).not.toContain('⚠ ČÁSTEČNĚ PROVĚŘENO');
    expect(text).not.toContain('✅');
  });

  it('all sources OK + no flags → ✅ ČISTÉ', () => {
    const text = buildDdSummaryMarkdown(report());
    expect(text).toContain('✅ ČISTÉ');
    expect(text).not.toContain('ČÁSTEČNĚ');
  });

  it('risk-score summary with unavailable sources shows ⚠ ČÁSTEČNĚ PROVĚŘENO', () => {
    const text = buildRiskScoreSummaryMarkdown({
      ico: '12345679',
      company_name: 'Test Co. s.r.o.',
      value: 0,
      level: 'low',
      top_flags: [],
      retrieved_at: NOW,
      unavailable_sources: [{ id: 'isir', label: 'ISIR' }],
    });
    expect(text).toContain('⚠ ČÁSTEČNĚ PROVĚŘENO');
    expect(text).not.toContain('✅');
  });
});

describe('audit wiring', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('tool succeeds even when audit POST fails (fire-and-forget)', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) => {
      if (typeof url === 'string' && url.includes('mcp-audit')) {
        throw new Error('audit endpoint unreachable');
      }
      // Pass through — should not be reached in unit test with mocked ares
      throw new Error(`unexpected fetch: ${url}`);
    });

    // Provide a real token so audit is attempted
    process.env.MCP_AUDIT_URL = 'https://app.cz-agents.dev';
    process.env.MCP_AUDIT_KEY = 'test-key';
    try {
      const ares = mockAres();
      const server = buildDdServer({ ares }, 'free', { audit: { tokenId: 'tok_test123' } });
      const tool = (server as unknown as { _registeredTools: Record<string, { handler: (args: unknown, extra?: unknown) => Promise<{ content: Array<{ text: string }> }> }> })
        ._registeredTools.get_risk_score;

      // Stub ares fetch to bypass network; the audit fetch mock throws — tool must still return.
      vi.spyOn(ares, 'getByIco').mockResolvedValue({
        ico: '12345679',
        obchodniJmeno: 'Test Co. s.r.o.',
        pravniForma: '112',
        datumVzniku: '2010-01-01',
        dic: 'CZ12345679',
        sidlo: { textovaAdresa: 'Testovací 1, Praha' },
      });
      vi.spyOn(ares, 'getBankAccounts').mockResolvedValue([]);
      vi.spyOn(ares, 'getVrRecord').mockResolvedValue(null);
      vi.spyOn(ares, 'search').mockResolvedValue({ pocetCelkem: 0, ekonomickeSubjekty: [] });

      // fetch is only called for audit (fire-and-forget) — mock above will throw but tool must succeed
      const response = await tool.handler({ ico: '12345679' });
      expect(response.content[0]?.text).toBeTruthy();
      // Audit was attempted (fetchSpy called with audit URL)
      await new Promise((r) => setTimeout(r, 10)); // let void promise settle
      const auditCalls = fetchSpy.mock.calls.filter((c) => String(c[0]).includes('mcp-audit'));
      expect(auditCalls.length).toBeGreaterThanOrEqual(1);
    } finally {
      delete process.env.MCP_AUDIT_URL;
      delete process.env.MCP_AUDIT_KEY;
    }
  });

  it('no audit call when tokenId absent', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('should not be called'));
    process.env.MCP_AUDIT_URL = 'https://app.cz-agents.dev';
    process.env.MCP_AUDIT_KEY = 'test-key';
    try {
      const ares = mockAres();
      vi.spyOn(ares, 'getByIco').mockResolvedValue({
        ico: '12345679',
        obchodniJmeno: 'Test Co. s.r.o.',
        pravniForma: '112',
        datumVzniku: '2010-01-01',
        dic: 'CZ12345679',
        sidlo: { textovaAdresa: 'Testovací 1, Praha' },
      });
      vi.spyOn(ares, 'getBankAccounts').mockResolvedValue([]);
      vi.spyOn(ares, 'getVrRecord').mockResolvedValue(null);
      vi.spyOn(ares, 'search').mockResolvedValue({ pocetCelkem: 0, ekonomickeSubjekty: [] });

      // No audit context → no tokenId → fetch must NOT be called
      const server = buildDdServer({ ares }, 'free');
      const tool = (server as unknown as { _registeredTools: Record<string, { handler: (args: unknown, extra?: unknown) => Promise<{ content: Array<{ text: string }> }> }> })
        ._registeredTools.get_risk_score;

      const response = await tool.handler({ ico: '12345679' });
      expect(response.content[0]?.text).toBeTruthy();
      await new Promise((r) => setTimeout(r, 10));
      const auditCalls = fetchSpy.mock.calls.filter((c) => String(c[0]).includes('mcp-audit'));
      expect(auditCalls.length).toBe(0);
    } finally {
      delete process.env.MCP_AUDIT_URL;
      delete process.env.MCP_AUDIT_KEY;
    }
  });
});

function mockAres(): AresLike {
  return {
    getByIco: async () => ({
      ico: '12345679',
      obchodniJmeno: 'Test Co. s.r.o.',
      pravniForma: '112',
      datumVzniku: '2010-01-01',
      dic: 'CZ12345679',
      sidlo: { textovaAdresa: 'Testovací 1, Praha' },
    }),
    getBankAccounts: async () => [{ cisloUctu: '123', kodBanky: '0100' }],
    getVrRecord: async () => ({
      ico: '12345679',
      statutarniOrgany: [{
        nazevOrganu: 'Jednatelé',
        clenoveOrganu: [{
          fyzickaOsoba: { jmeno: 'Jan', prijmeni: 'Test' },
          datumZapisu: '2020-01-01',
        }],
      }],
    }),
    search: async () => ({ pocetCelkem: 0, ekonomickeSubjekty: [] }),
  };
}
