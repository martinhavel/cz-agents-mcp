import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AresClient } from '../client.js';
import { buildAresServer } from '../server.js';

const ICO = '27074358';

async function connect(client: AresClient) {
  const server = buildAresServer({ client });
  const mcpClient = new Client({ name: 'journey-test', version: '1' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await mcpClient.connect(clientTransport);
  return { mcpClient, server };
}

describe('anonymous ARES monitoring CTA journey', () => {
  afterEach(() => vi.restoreAllMocks());

  it('delivers one contextual monitoring offer after a successful company journey', async () => {
    const upstream = {
      search: vi.fn().mockResolvedValue({
        pocetCelkem: 1,
        ekonomickeSubjekty: [{ ico: ICO, obchodniJmeno: 'Alza.cz a.s.' }],
      }),
      getByIco: vi.fn().mockResolvedValue({ ico: ICO, obchodniJmeno: 'Alza.cz a.s.' }),
      getResNacePrevazujici: vi.fn().mockResolvedValue(undefined),
      getVrRecord: vi.fn().mockResolvedValue({
        ico: ICO,
        obchodniJmeno: 'Alza.cz a.s.',
        statutarniOrgany: [{
          nazevOrganu: 'představenstvo',
          clenoveOrganu: [{
            funkce: { nazev: 'člen' },
            fyzickaOsoba: { jmeno: 'Test', prijmeni: 'Uživatel' },
          }],
        }],
      }),
    } as unknown as AresClient;
    const { mcpClient, server } = await connect(upstream);

    try {
      const search = await mcpClient.callTool({ name: 'search_companies', arguments: { query: 'Alza' } });
      const lookup = await mcpClient.callTool({ name: 'lookup_by_ico', arguments: { ico: ICO } });
      const result = await mcpClient.callTool({ name: 'get_statutaries', arguments: { ico: ICO } });
      const content = result.content as Array<{ type: string; text: string }>;

      expect(search.isError).not.toBe(true);
      expect(lookup.isError).not.toBe(true);
      expect(result.isError).not.toBe(true);
      expect(content[0]?.text).toContain('aktuální statutární orgány');
      expect(content.slice(1)).toHaveLength(1);
      expect(content[1]?.text).toMatch(/uložit/);
      expect(content[1]?.text).toMatch(/průběžné automatické hlídání/);
      expect(content[1]?.text).toMatch(/změny.*doručovat/);
      expect(content[1]?.text).toContain('bez opakovaných ručních dotazů');
      expect(content[1]?.text).toContain(`watch_entity pro IČO ${ICO}`);
    } finally {
      await mcpClient.close();
      await server.close();
    }
  });

  it('does not promise monitoring when the company has no registry record', async () => {
    const upstream = {
      getVrRecord: vi.fn().mockResolvedValue(null),
    } as unknown as AresClient;
    const { mcpClient, server } = await connect(upstream);

    try {
      const result = await mcpClient.callTool({ name: 'get_statutaries', arguments: { ico: ICO } });
      const text = (result.content as Array<{ type: string; text: string }>).map((block) => block.text).join('\n');

      expect(text).toContain('nemá záznam ve Veřejném rejstříku');
      expect(text).not.toContain('průběžné automatické hlídání');
    } finally {
      await mcpClient.close();
      await server.close();
    }
  });
});
