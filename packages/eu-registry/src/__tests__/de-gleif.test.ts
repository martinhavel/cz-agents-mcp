import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DeGleifAdapter, GleifAdapter } from '../adapters/de-gleif.js';
import { GleifCache } from '../gleif-cache.js';

type FetchArgs = Parameters<typeof fetch>;

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/vnd.api+json' },
  });
}

const RECORD = {
  id: 'W38RGI023J3WT1HWRP32',
  attributes: {
    entity: {
      legalName: { name: 'Siemens Aktiengesellschaft' },
      status: 'ACTIVE',
      jurisdiction: 'DE',
      registeredAs: 'HRB 6684',
      creationDate: '1996-08-27T22:00:00Z',
      legalAddress: {
        addressLines: ['Werner-von-Siemens-Str. 1'],
        city: 'München',
        postalCode: '80333',
        country: 'DE',
      },
    },
  },
};

describe('DeGleifAdapter', () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;
  let handler: (url: string) => Response | Promise<Response>;

  beforeEach(() => {
    handler = () => jsonResponse({});
    fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(
      (async (...args: FetchArgs) => {
        const url = args[0] instanceof URL ? args[0].toString() : String(args[0]);
        return handler(url);
      }) as typeof fetch,
    );
  });

  afterEach(() => {
    fetchSpy.mockRestore();
    vi.restoreAllMocks();
  });

  it('searchByName calls correct GLEIF URL with fulltext + DE jurisdiction', async () => {
    let capturedUrl: string | undefined;
    handler = (url) => {
      capturedUrl = url;
      return jsonResponse({ data: [RECORD], meta: { pagination: { total: 42 } } });
    };

    const adapter = new DeGleifAdapter();
    const result = await adapter.searchByName('Siemens', 5);

    expect(capturedUrl).toContain('api.gleif.org/api/v1/lei-records');
    expect(capturedUrl).toContain('filter%5Bfulltext%5D=Siemens');
    expect(capturedUrl).toContain('filter%5Bentity.jurisdiction%5D=DE');
    expect(capturedUrl).toContain('page%5Bsize%5D=5');
    expect(result).toEqual({
      total_results: 42,
      companies: [
        {
          id: 'W38RGI023J3WT1HWRP32',
          country: 'de',
          name: 'Siemens Aktiengesellschaft',
          status: 'active',
          address: 'Werner-von-Siemens-Str. 1, 80333, München',
          registered_on: '1996-08-27',
          lei: 'W38RGI023J3WT1HWRP32',
          source_url: 'https://search.gleif.org/#/record/W38RGI023J3WT1HWRP32',
        },
      ],
    });
  });

  it('getById calls /lei-records/{lei} and maps record', async () => {
    let capturedUrl: string | undefined;
    handler = (url) => {
      capturedUrl = url;
      return jsonResponse({ data: RECORD });
    };

    const adapter = new DeGleifAdapter();
    const company = await adapter.getById('W38RGI023J3WT1HWRP32');

    expect(capturedUrl).toContain('/lei-records/W38RGI023J3WT1HWRP32');
    expect(company?.name).toBe('Siemens Aktiengesellschaft');
    expect(company?.lei).toBe('W38RGI023J3WT1HWRP32');
  });

  it('getById returns null on 404', async () => {
    handler = () => jsonResponse({}, 404);
    await expect(new DeGleifAdapter().getById('BADLEI')).resolves.toBeNull();
  });

  it('maps INACTIVE status to dissolved', async () => {
    handler = () =>
      jsonResponse({
        data: [{ ...RECORD, attributes: { entity: { ...RECORD.attributes.entity, status: 'INACTIVE' } } }],
        meta: { pagination: { total: 1 } },
      });

    const result = await new DeGleifAdapter().searchByName('old');
    expect(result.companies[0]?.status).toBe('dissolved');
  });

  it('network error returns empty without throwing', async () => {
    handler = () => { throw new Error('network failed'); };
    await expect(new DeGleifAdapter().searchByName('test')).resolves.toEqual({
      companies: [],
      total_results: 0,
    });
  });

  it('getById cache key is namespaced per jurisdiction (no NL/DE leak)', async () => {
    handler = () => jsonResponse({ data: RECORD });
    const cache = new GleifCache(':memory:');
    const de = new GleifAdapter('DE', globalThis.fetch, cache);
    const nl = new GleifAdapter('NL', globalThis.fetch, cache);

    const deCompany = await de.getById('W38RGI023J3WT1HWRP32');
    const nlCompany = await nl.getById('W38RGI023J3WT1HWRP32'); // same LEI, shared cache

    // Each adapter stamps its own country — a shared bare `lei:${id}` key would have
    // leaked DE's cached company (country 'de') into the NL lookup.
    expect(deCompany?.country).toBe('de');
    expect(nlCompany?.country).toBe('nl');
  });
});
