import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DkCvrAdapter } from '../adapters/dk-cvr.js';

type FetchArgs = Parameters<typeof fetch>;

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

const RECORD = {
  cvrNummer: 25052943,
  virksomhedsstatus: 'NORMAL',
  navne: [{ navn: 'MAGENTA APS', periode: { gyldigFra: '1999-12-01', gyldigTil: null } }],
  beliggenhedsadresse: [
    {
      vejnavn: 'Pilestræde',
      husnummerFra: '43',
      postnummer: 1112,
      postdistrikt: 'København K',
      landekode: 'DK',
      periode: { gyldigFra: '2020-01-01', gyldigTil: null },
    },
  ],
  virksomhedMetadata: {
    nyesteNavn: { navn: 'MAGENTA APS' },
    nyesteBeliggenhedsadresse: {
      vejnavn: 'Pilestræde',
      husnummerFra: '43',
      postnummer: 1112,
      postdistrikt: 'København K',
      landekode: 'DK',
    },
  },
  livsforloeb: [{ periode: { gyldigFra: '1999-12-01', gyldigTil: null } }],
};

function searchPayload(record = RECORD, total: number | { value?: number } = 1) {
  return {
    hits: {
      total,
      hits: [{ _source: { Vrvirksomhed: record } }],
    },
  };
}

describe('DkCvrAdapter', () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;
  let handler: (url: string, init?: RequestInit) => Response | Promise<Response>;

  beforeEach(() => {
    vi.stubEnv('DK_CVR_USER', 'test-user');
    vi.stubEnv('DK_CVR_PASS', 'test-pass');
    handler = () => jsonResponse({});
    fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(
      (async (...args: FetchArgs) => {
        const url = args[0] instanceof URL ? args[0].toString() : String(args[0]);
        return handler(url, args[1]);
      }) as typeof fetch,
    );
  });

  afterEach(() => {
    fetchSpy.mockRestore();
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it('searchByName calls official CVR distribution URL and maps results', async () => {
    let captured: { url: string; init?: RequestInit } | undefined;
    handler = (url, init) => {
      captured = { url, init };
      return jsonResponse(searchPayload(RECORD, { value: 12 }));
    };

    const adapter = new DkCvrAdapter();
    const result = await adapter.searchByName('Magenta', 5);

    expect(captured?.url).toContain(
      'http://distribution.virk.dk/cvr-permanent/virksomhed/_search?',
    );
    expect(captured?.url).toContain(
      'q=Vrvirksomhed.virksomhedMetadata.nyesteNavn.navn%3A%22Magenta%22',
    );
    expect(captured?.url).toContain('size=5');
    expect(captured?.init?.headers).toMatchObject({
      Accept: 'application/json',
      Authorization: `Basic ${Buffer.from('test-user:test-pass').toString('base64')}`,
    });
    expect(result).toEqual({
      total_results: 12,
      companies: [
        {
          id: '25052943',
          country: 'dk',
          name: 'MAGENTA APS',
          status: 'active',
          address: 'Pilestræde, 43, 1112, København K, DK',
          registered_on: '1999-12-01',
          source_url: 'https://datacvr.virk.dk/enhed/virksomhed/25052943',
        },
      ],
    });
  });

  it('escapes Lucene operators in name (query-injection guard)', async () => {
    let capturedUrl: string | undefined;
    handler = (url) => {
      capturedUrl = url;
      return jsonResponse(searchPayload());
    };
    await new DkCvrAdapter().searchByName('x" OR cvrNummer:*', 5);
    const q = new URL(capturedUrl!).searchParams.get('q');
    // user input wrapped in a quoted phrase + the breakout " escaped → operators are literal
    expect(q).toBe('Vrvirksomhed.virksomhedMetadata.nyesteNavn.navn:"x\\" OR cvrNummer:*"');
  });

  it('getById rejects non-numeric id without fetching (injection guard)', async () => {
    handler = () => {
      throw new Error('should not fetch for non-numeric id');
    };
    expect(await new DkCvrAdapter().getById('1 OR 1=1')).toBeNull();
  });

  it('getById searches by cvrNummer and returns exact match', async () => {
    let capturedUrl: string | undefined;
    handler = (url) => {
      capturedUrl = url;
      return jsonResponse(searchPayload());
    };

    const adapter = new DkCvrAdapter();
    const company = await adapter.getById('25052943');

    expect(capturedUrl).toContain('q=Vrvirksomhed.cvrNummer%3A25052943');
    expect(capturedUrl).toContain('size=1');
    expect(company?.id).toBe('25052943');
    expect(company?.name).toBe('MAGENTA APS');
  });

  it('getById returns null when no hits are found', async () => {
    handler = () => jsonResponse({ hits: { total: 0, hits: [] } });

    await expect(new DkCvrAdapter().getById('99999999')).resolves.toBeNull();
  });

  it('getById returns null when the top hit is a different CVR number', async () => {
    handler = () => jsonResponse(searchPayload());

    await expect(new DkCvrAdapter().getById('99999999')).resolves.toBeNull();
  });

  it('maps dissolved virksomhedsstatus', async () => {
    handler = () =>
      jsonResponse(searchPayload({ ...RECORD, virksomhedsstatus: 'OPHØRT' }));

    const result = await new DkCvrAdapter().searchByName('old');

    expect(result.companies[0]?.status).toBe('dissolved');
  });

  it('missing DK_CVR_USER / DK_CVR_PASS returns empty/null without throwing', async () => {
    vi.stubEnv('DK_CVR_USER', '');
    vi.stubEnv('DK_CVR_PASS', '');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const adapter = new DkCvrAdapter();

    await expect(adapter.searchByName('Magenta')).resolves.toEqual({
      companies: [],
      total_results: 0,
    });
    await expect(adapter.getById('25052943')).resolves.toBeNull();
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith(
      '[cz-agents/eu-registry] DK CVR not configured: set DK_CVR_USER and DK_CVR_PASS',
    );
  });
});

describe('reklamebeskyttelse (license term)', () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.stubEnv('DK_CVR_USER', 'test-user');
    vi.stubEnv('DK_CVR_PASS', 'test-pass');
  });

  afterEach(() => {
    fetchSpy?.mockRestore();
    vi.unstubAllEnvs();
  });

  function stub(record: Record<string, unknown>) {
    fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      jsonResponse(searchPayload(record as typeof RECORD)),
    );
  }

  it('propagates marketing_protected=true for reklamebeskyttet entities', async () => {
    stub({ ...RECORD, reklamebeskyttet: true });
    const result = await new DkCvrAdapter().searchByName('Magenta');
    expect(result.companies[0]?.marketing_protected).toBe(true);
  });

  it('omits the field entirely when not protected (other countries unchanged)', async () => {
    stub({ ...RECORD, reklamebeskyttet: false });
    const result = await new DkCvrAdapter().searchByName('Magenta');
    expect('marketing_protected' in (result.companies[0] ?? {})).toBe(false);
  });
});
