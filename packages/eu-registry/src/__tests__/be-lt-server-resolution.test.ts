import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildEuRegistryServer } from '../server.js';
import { GleifAdapter } from '../adapters/de-gleif.js';
import { ViesGleifAdapter } from '../adapters/vies-gleif.js';

// Wires be/lt the same way server.ts's default adapter map does (ViesGleifAdapter +
// GleifAdapter), so these tests exercise the real production wiring added for the
// BE/LT rollout — just with fetch mocked instead of hitting GLEIF/VIES live.
function beLtAdapters() {
  return {
    be: new ViesGleifAdapter('be', new GleifAdapter('BE')),
    lt: new ViesGleifAdapter('lt', new GleifAdapter('LT')),
  };
}

type FetchArgs = Parameters<typeof fetch>;

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

function parsed(result: Awaited<ReturnType<Client['callTool']>>): any {
  const block = result.content[0];
  if (!block || block.type !== 'text') throw new Error('text expected');
  return JSON.parse(block.text);
}

async function clientFor(options: Parameters<typeof buildEuRegistryServer>[0]) {
  const server = buildEuRegistryServer(options);
  const client = new Client({ name: 'test', version: '1' });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await server.connect(st);
  await client.connect(ct);
  return { client, server };
}

describe('BE/LT country resolution and fanout', () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    fetchSpy = vi.spyOn(globalThis, 'fetch');
  });

  afterEach(() => {
    fetchSpy.mockRestore();
  });

  it('resolves ISO code "BE" to the be adapter for search_company', async () => {
    let capturedUrl = '';
    fetchSpy.mockImplementation((async (...args: FetchArgs) => {
      capturedUrl = args[0] instanceof URL ? args[0].toString() : String(args[0]);
      return jsonResponse({ data: [], meta: { pagination: { total: 0 } } });
    }) as typeof fetch);
    const { client, server } = await clientFor({ adapters: beLtAdapters() });
    try {
      const result = await client.callTool({ name: 'search_company', arguments: { name: 'Solvay', country: 'BE' } });
      expect(capturedUrl).toContain('filter%5Bentity.jurisdiction%5D=BE');
      expect(parsed(result)).toEqual({ companies: [], total_results: 0 });
    } finally {
      await client.close();
      await server.close();
    }
  });

  it('resolves the country name alias "Lithuania" to the lt adapter', async () => {
    let capturedUrl = '';
    fetchSpy.mockImplementation((async (...args: FetchArgs) => {
      capturedUrl = args[0] instanceof URL ? args[0].toString() : String(args[0]);
      return jsonResponse({ data: [], meta: { pagination: { total: 0 } } });
    }) as typeof fetch);
    const { client, server } = await clientFor({ adapters: beLtAdapters() });
    try {
      await client.callTool({ name: 'search_company', arguments: { name: 'Telia', country: 'Lithuania' } });
      expect(capturedUrl).toContain('filter%5Bentity.jurisdiction%5D=LT');
    } finally {
      await client.close();
      await server.close();
    }
  });

  it('routes get_company BE VAT id through VIES', async () => {
    let capturedUrl = '';
    fetchSpy.mockImplementation((async (...args: FetchArgs) => {
      capturedUrl = args[0] instanceof URL ? args[0].toString() : String(args[0]);
      return jsonResponse({ isValid: true, name: 'NV KBC Bank', address: 'Havenlaan 2\n1080 Sint-Jans-Molenbeek' });
    }) as typeof fetch);
    const { client, server } = await clientFor({ adapters: beLtAdapters() });
    try {
      const result = await client.callTool({ name: 'get_company', arguments: { id: 'BE0462920226', country: 'BE' } });
      expect(capturedUrl).toContain('/vies/rest-api/ms/BE/vat/0462920226');
      expect(parsed(result)).toMatchObject({ id: 'BE0462920226', country: 'be', name: 'NV KBC Bank', status: 'active' });
    } finally {
      await client.close();
      await server.close();
    }
  });

  it('routes get_company LT VAT id through VIES', async () => {
    let capturedUrl = '';
    fetchSpy.mockImplementation((async (...args: FetchArgs) => {
      capturedUrl = args[0] instanceof URL ? args[0].toString() : String(args[0]);
      return jsonResponse({ isValid: true, name: 'AB SEB bankas', address: 'Konstitucijos pr. 24, Vilniaus m.' });
    }) as typeof fetch);
    const { client, server } = await clientFor({ adapters: beLtAdapters() });
    try {
      const result = await client.callTool({ name: 'get_company', arguments: { id: 'LT120212314', country: 'LT' } });
      expect(capturedUrl).toContain('/vies/rest-api/ms/LT/vat/120212314');
      expect(parsed(result)).toMatchObject({ id: 'LT120212314', country: 'lt', name: 'AB SEB bankas', status: 'active' });
    } finally {
      await client.close();
      await server.close();
    }
  });

  it('fans out across be and lt together when no country filter is given', async () => {
    fetchSpy.mockImplementation((async (...args: FetchArgs) => {
      const url = args[0] instanceof URL ? args[0].toString() : String(args[0]);
      if (url.includes('jurisdiction%5D=BE')) {
        return jsonResponse({
          data: [{ id: 'BELEI1', attributes: { entity: { legalName: { name: 'Belgian Co' }, status: 'ACTIVE', jurisdiction: 'BE' } } }],
          meta: { pagination: { total: 1 } },
        });
      }
      if (url.includes('jurisdiction%5D=LT')) {
        return jsonResponse({
          data: [{ id: 'LTLEI1', attributes: { entity: { legalName: { name: 'Lithuanian Co' }, status: 'ACTIVE', jurisdiction: 'LT' } } }],
          meta: { pagination: { total: 1 } },
        });
      }
      return jsonResponse({ data: [], meta: { pagination: { total: 0 } } });
    }) as typeof fetch);
    const { client, server } = await clientFor({ adapters: beLtAdapters() });
    try {
      const result = await client.callTool({ name: 'search_company', arguments: { name: 'co' } });
      const body = parsed(result);
      expect(body.total_results).toBe(2);
      const countries = body.companies.map((c: { country: string }) => c.country).sort();
      expect(countries).toEqual(['be', 'lt']);
    } finally {
      await client.close();
      await server.close();
    }
  });
});
