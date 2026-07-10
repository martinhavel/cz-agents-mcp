import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FiPrhAdapter } from '../adapters/fi-prh.js';

type FetchArgs = Parameters<typeof fetch>;

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

// Fields and values captured from the live PRH YTJ v3 businessId=0112038-9 response on 2026-07-10.
const NOKIA = {
  businessId: { value: '0112038-9', registrationDate: '1978-03-15', source: '3' },
  names: [
    { name: 'Nokia Oyj', type: '1', registrationDate: '1997-09-01', version: 1, source: '1' },
    { name: 'Oy Nokia Ab', type: '1', registrationDate: '1966-06-10', endDate: '1997-08-31', version: 2, source: '1' },
    { name: 'Nokia Networks', type: '3', registrationDate: '2001-10-01', version: 1, source: '1' },
  ],
  addresses: [
    {
      type: 1,
      street: 'Karakaari',
      postCode: '02610',
      postOffices: [
        { city: 'ESBO', languageCode: '2', municipalityCode: '049' },
        { city: 'ESPOO', languageCode: '1', municipalityCode: '049' },
      ],
      buildingNumber: '7',
      entrance: '',
      apartmentNumber: '',
      apartmentIdSuffix: '',
      co: '',
      registrationDate: '2019-07-01',
      source: '0',
    },
  ],
  tradeRegisterStatus: '1',
  status: '2',
  registrationDate: '1896-12-19',
  lastModified: '2026-06-08T14:49:11',
};

// Captured in the same live name=Nokia response: tradeRegisterStatus "4" is ceased.
const CEASED_NOSTONOKIA = {
  businessId: { value: '0157684-5', registrationDate: '1978-03-15', source: '3' },
  names: [
    { name: 'Nostonokia Oy', type: '1', registrationDate: '2003-06-01', endDate: '2006-07-01', version: 1, source: '1' },
    { name: 'Velj. Tuomola, kuljetusliike', type: '1', registrationDate: '1964-03-13', endDate: '2003-05-31', version: 2, source: '1' },
  ],
  addresses: [],
  tradeRegisterStatus: '4',
  status: '2',
  registrationDate: '1964-03-13',
  endDate: '2006-07-01',
  lastModified: '2019-01-29T07:32:19',
};

function payload(companies = [NOKIA], totalResults = companies.length) {
  return { totalResults, companies };
}

describe('FiPrhAdapter', () => {
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

  it('searchByName calls PRH YTJ v3 and maps the captured live response shape', async () => {
    let captured: { url: string; init?: RequestInit } | undefined;
    handler = (url, init) => {
      captured = { url, init };
      return jsonResponse(payload([NOKIA], 986));
    };

    const result = await new FiPrhAdapter().searchByName('Nokia', 5);

    expect(captured?.url).toBe('https://avoindata.prh.fi/opendata-ytj-api/v3/companies?name=Nokia');
    expect(captured?.init?.headers).toMatchObject({
      Accept: 'application/json',
      'User-Agent': 'cz-agents eu-registry (+https://github.com/martinhavel/cz-agents-mcp)',
    });
    expect(result).toEqual({
      total_results: 986,
      companies: [{
        id: '0112038-9',
        country: 'fi',
        name: 'Nokia Oyj',
        status: 'active',
        address: 'Karakaari 7, 02610, ESPOO',
        registered_on: '1896-12-19',
        source_url: 'https://tietopalvelu.ytj.fi/yritys/0112038-9',
      }],
    });
  });

  it('getById calls the businessId endpoint and returns the exact company', async () => {
    let capturedUrl: string | undefined;
    handler = (url) => {
      capturedUrl = url;
      return jsonResponse(payload());
    };

    await expect(new FiPrhAdapter().getById('0112038-9')).resolves.toMatchObject({
      id: '0112038-9', name: 'Nokia Oyj',
    });
    expect(capturedUrl).toBe('https://avoindata.prh.fi/opendata-ytj-api/v3/companies?businessId=0112038-9');
  });

  it('returns an empty search result when PRH returns no companies', async () => {
    handler = () => jsonResponse(payload([], 0));

    await expect(new FiPrhAdapter().searchByName('no such company')).resolves.toEqual({
      companies: [], total_results: 0,
    });
  });

  it('maps the captured ceased trade-register status to dissolved', async () => {
    handler = () => jsonResponse(payload([CEASED_NOSTONOKIA]));

    const result = await new FiPrhAdapter().searchByName('Nostonokia');

    expect(result.companies[0]).toMatchObject({
      id: '0157684-5', name: 'Nostonokia Oy', status: 'dissolved',
    });
  });

  it('returns empty/null for HTTP error responses', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    handler = () => jsonResponse({ error: 'upstream failure' }, 503);
    const adapter = new FiPrhAdapter();

    await expect(adapter.searchByName('Nokia')).resolves.toEqual({ companies: [], total_results: 0 });
    await expect(adapter.getById('0112038-9')).resolves.toBeNull();
    expect(warn).toHaveBeenCalledTimes(2);
  });
});
