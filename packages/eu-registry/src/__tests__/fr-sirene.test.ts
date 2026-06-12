import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FrSireneAdapter } from '../adapters/fr-sirene.js';

type FetchArgs = Parameters<typeof fetch>;

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

const RESULT = {
  siren: '542051180',
  nom_complet: 'TOTALENERGIES SE',
  nom_raison_sociale: 'TOTALENERGIES SE',
  etat_administratif: 'A',
  date_creation: '1924-03-28',
  siege: { adresse: 'LA DEFENSE 6 2 PLACE JEAN MILLIER 92400 COURBEVOIE' },
};

describe('FrSireneAdapter', () => {
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

  it('searchByName calls correct URL and maps results', async () => {
    let capturedUrl: string | undefined;
    handler = (url) => {
      capturedUrl = url;
      return jsonResponse({ results: [RESULT], total_results: 1000 });
    };

    const adapter = new FrSireneAdapter();
    const result = await adapter.searchByName('totalenergies', 5);

    expect(capturedUrl).toBe(
      'https://recherche-entreprises.api.gouv.fr/search?q=totalenergies&per_page=5',
    );
    expect(result).toEqual({
      total_results: 1000,
      companies: [
        {
          id: '542051180',
          country: 'fr',
          name: 'TOTALENERGIES SE',
          status: 'active',
          address: 'LA DEFENSE 6 2 PLACE JEAN MILLIER 92400 COURBEVOIE',
          registered_on: '1924-03-28',
          source_url: 'https://annuaire-entreprises.data.gouv.fr/entreprise/542051180',
        },
      ],
    });
  });

  it('getById searches by SIREN and returns first result', async () => {
    let capturedUrl: string | undefined;
    handler = (url) => {
      capturedUrl = url;
      return jsonResponse({ results: [RESULT], total_results: 1 });
    };

    const adapter = new FrSireneAdapter();
    const company = await adapter.getById('542051180');

    expect(capturedUrl).toBe(
      'https://recherche-entreprises.api.gouv.fr/search?q=542051180&per_page=1',
    );
    expect(company?.id).toBe('542051180');
  });

  it('getById returns null when the top result is a different SIREN', async () => {
    // Fuzzy /search can surface a near-but-wrong company; must not return it.
    handler = () => jsonResponse({ results: [RESULT], total_results: 1 }); // siren 542051180
    const adapter = new FrSireneAdapter();
    const company = await adapter.getById('999999999');
    expect(company).toBeNull();
  });

  it('getById matches ignoring SIREN formatting (spaces)', async () => {
    handler = () => jsonResponse({ results: [RESULT], total_results: 1 });
    const adapter = new FrSireneAdapter();
    const company = await adapter.getById('542 051 180');
    expect(company?.id).toBe('542051180');
  });

  it('maps etat_administratif C to dissolved', async () => {
    handler = () =>
      jsonResponse({ results: [{ ...RESULT, etat_administratif: 'C' }], total_results: 1 });

    const adapter = new FrSireneAdapter();
    const result = await adapter.searchByName('test');
    expect(result.companies[0]?.status).toBe('dissolved');
  });

  it('non-200 returns empty without throwing', async () => {
    handler = () => jsonResponse({}, 500);
    const adapter = new FrSireneAdapter();

    await expect(adapter.searchByName('test')).resolves.toEqual({
      companies: [],
      total_results: 0,
    });
  });

  it('network error returns empty without throwing', async () => {
    handler = () => { throw new Error('network failed'); };
    const adapter = new FrSireneAdapter();

    await expect(adapter.searchByName('test')).resolves.toEqual({
      companies: [],
      total_results: 0,
    });
  });
});
