import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NoBrregAdapter } from '../adapters/no-brreg.js';

type FetchArgs = Parameters<typeof fetch>;

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

const ENTITY = {
  organisasjonsnummer: '987654321',
  navn: 'ACME NORGE AS',
  konkurs: false,
  underAvvikling: false,
  stiftelsesdato: '2020-01-02',
  forretningsadresse: {
    adresse: ['Testveien 1'],
    postnummer: '0150',
    poststed: 'Oslo',
    land: 'Norge',
  },
};

describe('NoBrregAdapter', () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;
  let handler: (url: string, init?: RequestInit) => Response | Promise<Response>;

  beforeEach(() => {
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
    vi.restoreAllMocks();
  });

  it('searchByName calls correct BRREG URL and maps _embedded.enheter', async () => {
    let captured: { url: string; init?: RequestInit } | undefined;
    handler = (url, init) => {
      captured = { url, init };
      return jsonResponse({
        _embedded: { enheter: [ENTITY] },
        page: { totalElements: 42 },
      });
    };

    const adapter = new NoBrregAdapter();
    const result = await adapter.searchByName('ACME', 5);

    expect(captured?.url).toBe(
      'https://data.brreg.no/enhetsregisteret/api/enheter?navn=ACME&size=5',
    );
    expect(captured?.init?.headers).toMatchObject({ Accept: 'application/json' });
    expect(result).toEqual({
      total_results: 42,
      companies: [
        {
          id: '987654321',
          country: 'no',
          name: 'ACME NORGE AS',
          status: 'active',
          address: 'Testveien 1, 0150, Oslo, Norge',
          registered_on: '2020-01-02',
          source_url: 'https://data.brreg.no/enhetsregisteret/oppslag/enheter/987654321',
        },
      ],
    });
  });

  it('getById calls /enheter/{orgnr} and maps company', async () => {
    let capturedUrl: string | undefined;
    handler = (url) => {
      capturedUrl = url;
      return jsonResponse(ENTITY);
    };

    const adapter = new NoBrregAdapter();
    const company = await adapter.getById('987654321');

    expect(capturedUrl).toBe('https://data.brreg.no/enhetsregisteret/api/enheter/987654321');
    expect(company?.id).toBe('987654321');
    expect(company?.name).toBe('ACME NORGE AS');
  });

  it('getById returns null on 404', async () => {
    handler = () => jsonResponse({}, 404);

    await expect(new NoBrregAdapter().getById('missing')).resolves.toBeNull();
  });

  it.each([
    { konkurs: true },
    { underAvvikling: true },
    { slettedato: '2024-01-01' },
  ])('maps dissolved status for %j', async (patch) => {
    handler = () => jsonResponse({ _embedded: { enheter: [{ ...ENTITY, ...patch }] } });

    const result = await new NoBrregAdapter().searchByName('old');

    expect(result.companies[0]?.status).toBe('dissolved');
  });

  it('non-200 on searchByName returns empty results without throwing', async () => {
    handler = () => jsonResponse({}, 500);

    await expect(new NoBrregAdapter().searchByName('ACME')).resolves.toEqual({
      companies: [],
      total_results: 0,
    });
  });
});
