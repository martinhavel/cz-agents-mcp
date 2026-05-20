import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SkOrsrAdapter } from '../adapters/sk-orsr.js';

type FetchArgs = Parameters<typeof fetch>;

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('SkOrsrAdapter', () => {
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

  it('searchByName maps RPO content to companies', async () => {
    let capturedUrl: string | undefined;
    handler = (url) => {
      capturedUrl = url;
      return jsonResponse({
        totalElements: 1,
        content: [
          {
            cin: '31333532',
            name: 'ACME SLOVAKIA s.r.o.',
            legalForm: { value: 'Spoločnosť s ručením obmedzeným' },
            address: { formattedAddress: 'Hlavná 1, Bratislava' },
            registrationDate: '2020-01-02',
            terminationDate: null,
          },
        ],
      });
    };

    const adapter = new SkOrsrAdapter();
    const result = await adapter.searchByName('ACME', 5);

    expect(capturedUrl).toBe('https://rpo.statistics.sk/rpo/api/v1/subject?name=ACME&page=0&size=5');
    expect(result).toEqual({
      total_results: 1,
      companies: [
        {
          id: '31333532',
          country: 'sk',
          name: 'ACME SLOVAKIA s.r.o.',
          status: 'active',
          address: 'Hlavná 1, Bratislava',
          registered_on: '2020-01-02',
          source_url: 'https://www.orsr.sk/hladanie.asp?OBMENO=ACME%20SLOVAKIA%20s.r.o.&BTN=Hľadaj',
        },
      ],
    });
  });

  it('getById returns mapped company from single subject response', async () => {
    handler = () =>
      jsonResponse({
        cin: '31333532',
        name: 'ACME SLOVAKIA s.r.o.',
        address: { formattedAddress: 'Hlavná 1, Bratislava' },
        registrationDate: '2020-01-02',
        terminationDate: null,
      });

    const adapter = new SkOrsrAdapter();

    await expect(adapter.getById('31333532')).resolves.toEqual({
      id: '31333532',
      country: 'sk',
      name: 'ACME SLOVAKIA s.r.o.',
      status: 'active',
      address: 'Hlavná 1, Bratislava',
      registered_on: '2020-01-02',
      source_url: 'https://www.orsr.sk/hladanie.asp?OBMENO=ACME%20SLOVAKIA%20s.r.o.&BTN=Hľadaj',
    });
  });

  it('getById returns null on 404 without throwing', async () => {
    handler = () => jsonResponse({}, 404);
    const adapter = new SkOrsrAdapter();

    await expect(adapter.getById('missing')).resolves.toBeNull();
  });

  it('network error on searchByName returns empty results without throwing', async () => {
    handler = () => {
      throw new Error('network failed');
    };
    const adapter = new SkOrsrAdapter();

    await expect(adapter.searchByName('ACME')).resolves.toEqual({ companies: [], total_results: 0 });
  });
});
