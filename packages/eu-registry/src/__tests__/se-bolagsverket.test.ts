import { afterEach, describe, expect, it, vi } from 'vitest';
import { SeBolagsverketAdapter } from '../adapters/se-bolagsverket.js';
import type { RegistryAdapter } from '../types.js';

const VOLVO = {
  organisationer: [{
    avregistreradOrganisation: null,
    organisationsdatum: { registreringsdatum: '1915-05-05', dataproducent: 'Bolagsverket', fel: null },
    organisationsidentitet: {
      identitetsbeteckning: '5560125790',
      typ: { kod: 'ORGNR', klartext: 'Organisationsnummer' },
    },
    organisationsnamn: {
      dataproducent: 'Bolagsverket',
      fel: null,
      organisationsnamnLista: [{
        namn: 'Aktiebolaget Volvo',
        organisationsnamntyp: { kod: 'FORETAGSNAMN', klartext: 'Företagsnamn' },
        registreringsdatum: '1915-05-05',
      }],
    },
    postadressOrganisation: {
      postadress: {
        postnummer: '40508', coAdress: null, land: null, postort: 'GÖTEBORG', utdelningsadress: null,
      },
      dataproducent: 'Bolagsverket',
      fel: null,
    },
    reklamsparr: { kod: 'JA', dataproducent: 'SCB', fel: null },
    verksamOrganisation: { kod: 'JA', dataproducent: 'SCB', fel: null },
  }],
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function configured(fetchImpl: typeof fetch, searchAdapter?: RegistryAdapter, now?: () => number) {
  return new SeBolagsverketAdapter({
    clientId: 'client-id',
    clientSecret: 'client-secret',
    fetchImpl,
    searchAdapter,
    now,
  });
}

describe('SeBolagsverketAdapter', () => {
  afterEach(() => vi.restoreAllMocks());

  it('uses OAuth client credentials and maps the captured live Volvo response', async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const fetchImpl = vi.fn(async (input: URL | RequestInfo, init?: RequestInit) => {
      const url = String(input);
      calls.push({ url, init });
      if (url.endsWith('/oauth2/token')) {
        return jsonResponse({ access_token: 'access-token', token_type: 'Bearer', expires_in: 3600 });
      }
      return jsonResponse(VOLVO);
    }) as unknown as typeof fetch;

    const result = await configured(fetchImpl).getById('556012-5790');

    expect(result).toEqual({
      id: '5560125790',
      country: 'se',
      name: 'Aktiebolaget Volvo',
      status: 'active',
      address: '40508, GÖTEBORG',
      registered_on: '1915-05-05',
      source_url: 'https://foretagsinfo.bolagsverket.se/sok-foretagsinformation-web/',
      marketing_protected: true,
    });
    expect(calls).toHaveLength(2);
    expect(calls[0]?.url).toBe('https://portal.api.bolagsverket.se/oauth2/token');
    expect(calls[0]?.init?.method).toBe('POST');
    expect(String(calls[0]?.init?.body)).toBe(
      'grant_type=client_credentials&scope=vardefulla-datamangder%3Aread',
    );
    expect(calls[0]?.init?.headers).toMatchObject({
      Authorization: `Basic ${Buffer.from('client-id:client-secret').toString('base64')}`,
    });
    expect(calls[1]?.url).toBe(
      'https://gw.api.bolagsverket.se/vardefulla-datamangder/v1/organisationer',
    );
    expect(calls[1]?.init?.headers).toMatchObject({ Authorization: 'Bearer access-token' });
    expect(calls[1]?.init?.body).toBe(JSON.stringify({ identitetsbeteckning: '5560125790' }));
  });

  it('caches the access token until shortly before expiry', async () => {
    let now = 1_000;
    const fetchImpl = vi.fn(async (input: URL | RequestInfo) => {
      if (String(input).endsWith('/oauth2/token')) {
        return jsonResponse({ access_token: 'cached-token', expires_in: 3600 });
      }
      return jsonResponse(VOLVO);
    }) as unknown as typeof fetch;
    const adapter = configured(fetchImpl, undefined, () => now);

    await adapter.getById('5560125790');
    now += 30_000;
    await adapter.getById('5560125790');

    expect(fetchImpl).toHaveBeenCalledTimes(3);
    expect(fetchImpl.mock.calls.filter(([input]) => String(input).endsWith('/oauth2/token'))).toHaveLength(1);
  });

  it('delegates name search to the GLEIF fallback', async () => {
    const expected = {
      companies: [{ id: 'LEI123', country: 'se', name: 'Volvo', status: 'active' as const }],
      total_results: 1,
    };
    const searchAdapter: RegistryAdapter = {
      searchByName: vi.fn().mockResolvedValue(expected),
      getById: vi.fn(),
    };

    await expect(configured(vi.fn() as unknown as typeof fetch, searchAdapter).searchByName('Volvo', 4))
      .resolves.toEqual(expected);
    expect(searchAdapter.searchByName).toHaveBeenCalledWith('Volvo', 4);
  });

  it('maps inactive or deregistered organisations to dissolved', async () => {
    const inactive = structuredClone(VOLVO);
    inactive.organisationer[0]!.verksamOrganisation!.kod = 'NEJ';
    inactive.organisationer[0]!.avregistreradOrganisation = { avregistreringsdatum: '2024-01-01' };
    inactive.organisationer[0]!.reklamsparr = null;
    const fetchImpl = vi.fn(async (input: URL | RequestInfo) => (
      String(input).endsWith('/oauth2/token')
        ? jsonResponse({ access_token: 'token', expires_in: 3600 })
        : jsonResponse(inactive)
    )) as unknown as typeof fetch;

    await expect(configured(fetchImpl).getById('5560125790')).resolves.toMatchObject({
      status: 'dissolved',
    });
    await expect(configured(fetchImpl).getById('5560125790')).resolves.not.toHaveProperty('marketing_protected');
  });

  it('rejects malformed IDs before making network requests', async () => {
    const fetchImpl = vi.fn() as unknown as typeof fetch;

    await expect(configured(fetchImpl).getById('556012-579X')).resolves.toBeNull();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('fails closed when credentials are missing or upstream returns an error', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ error: 'unavailable' }, 503)) as typeof fetch;

    await expect(new SeBolagsverketAdapter({
      clientId: '', clientSecret: '', fetchImpl,
    }).getById('5560125790')).resolves.toBeNull();
    await expect(configured(fetchImpl).getById('5560125790')).resolves.toBeNull();
    expect(warn).toHaveBeenCalledTimes(2);
  });
});
