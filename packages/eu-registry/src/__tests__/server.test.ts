import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildEuRegistryServer } from '../server.js';
import type { RegistryAdapter } from '../types.js';

async function connectTestClient(adapter: RegistryAdapter) {
  const server = buildEuRegistryServer({ adapters: { gb: adapter } });
  const client = new Client({ name: 'test-client', version: '0.1.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  return { client, server };
}

function text(result: Awaited<ReturnType<Client['callTool']>>): string {
  const first = result.content[0];
  if (!first || first.type !== 'text') throw new Error('Expected text content');
  return first.text;
}

describe('buildEuRegistryServer', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('handles search_company', async () => {
    const adapter: RegistryAdapter = {
      searchByName: vi.fn().mockResolvedValue({
        total_results: 1,
        companies: [
          {
            id: '14356670',
            country: 'gb',
            name: 'ACME LIMITED',
            status: 'active',
          },
        ],
      }),
      getById: vi.fn(),
    };
    const { client, server } = await connectTestClient(adapter);

    try {
      const result = await client.callTool({
        name: 'search_company',
        arguments: { name: 'acme', country: 'GB', limit: 20 },
      });

      expect(adapter.searchByName).toHaveBeenCalledWith('acme', 20);
      expect(JSON.parse(text(result))).toEqual({
        total_results: 1,
        companies: [
          {
            id: '14356670',
            country: 'gb',
            name: 'ACME LIMITED',
            status: 'active',
          },
        ],
      });
    } finally {
      await client.close();
      await server.close();
    }
  });

  it('handles get_company', async () => {
    const adapter: RegistryAdapter = {
      searchByName: vi.fn(),
      getById: vi.fn().mockResolvedValue({
        id: '14356670',
        country: 'gb',
        name: 'ACME LIMITED',
        status: 'active',
      }),
    };
    const { client, server } = await connectTestClient(adapter);

    try {
      const result = await client.callTool({
        name: 'get_company',
        arguments: { id: '14356670', country: 'GB' },
      });

      expect(adapter.getById).toHaveBeenCalledWith('14356670');
      expect(JSON.parse(text(result))).toEqual({
        id: '14356670',
        country: 'gb',
        name: 'ACME LIMITED',
        status: 'active',
      });
    } finally {
      await client.close();
      await server.close();
    }
  });
});
