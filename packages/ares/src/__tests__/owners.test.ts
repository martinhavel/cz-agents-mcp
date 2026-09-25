import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { AresClient, extractOwners, type AresVrRecord } from '../client.js';
import { buildAresServer } from '../server.js';

type FetchArgs = Parameters<typeof fetch>;

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('extractOwners', () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;
  let handler: (url: string, init?: RequestInit) => Response | Promise<Response>;

  beforeEach(() => {
    handler = () => jsonResponse({});
    fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(
      (async (...args: FetchArgs) => {
        const url = typeof args[0] === 'string' ? args[0] : String(args[0]);
        return handler(url, args[1]);
      }) as typeof fetch,
    );
  });

  afterEach(() => {
    fetchSpy.mockRestore();
  });

  it('extracts 2 společníci (FO + PO) with their podíl from an s.r.o. VR fixture', async () => {
    handler = () =>
      jsonResponse({
        zaznamy: [
          {
            ico: '12345678',
            obchodniJmeno: 'Testovací s.r.o.',
            stavSubjektu: 'AKTIVNI',
            spolecnici: [
              {
                spolecnik: [
                  {
                    osoba: {
                      fyzickaOsoba: {
                        jmeno: 'Jan',
                        prijmeni: 'Novák',
                        datumNarozeni: '1980-05-01',
                      },
                    },
                    podil: [
                      {
                        velikostPodilu: { hodnota: '50%' },
                        vklad: { hodnota: '100000 Kč' },
                        splaceni: { hodnota: '100000 Kč' },
                      },
                    ],
                    datumZapisu: '2015-01-01',
                    datumVymazu: null,
                  },
                  {
                    osoba: {
                      pravnickaOsoba: {
                        ico: '87654321',
                        obchodniJmeno: 'Holding a.s.',
                      },
                    },
                    podil: [
                      {
                        velikostPodilu: { hodnota: '50%' },
                        vklad: { hodnota: '100000 Kč' },
                        splaceni: { hodnota: '100000 Kč' },
                      },
                    ],
                    datumZapisu: '2015-01-01',
                    datumVymazu: null,
                  },
                ],
              },
            ],
          },
        ],
      });
    const c = new AresClient();
    const vr = await c.getVrRecord('12345678');
    const owners = extractOwners(vr!);

    expect(owners).toHaveLength(2);

    expect(owners[0]).toMatchObject({
      role: 'spolecnik',
      typ: 'FO',
      jmeno: 'Jan Novák',
      datumNarozeni: '1980-05-01',
      podil: { velikostPodilu: '50%', vklad: '100000 Kč', splaceno: '100000 Kč' },
    });
    expect(owners[0]?.datumZaniku).toBeUndefined();

    expect(owners[1]).toMatchObject({
      role: 'spolecnik',
      typ: 'PO',
      nazev: 'Holding a.s.',
      ico: '87654321',
      podil: { velikostPodilu: '50%', vklad: '100000 Kč', splaceno: '100000 Kč' },
    });
  });

  it('returns an empty list (no error) for an a.s. with no akcionáři in VR data', async () => {
    handler = () =>
      jsonResponse({
        zaznamy: [
          {
            ico: '11122233',
            obchodniJmeno: 'Testovací a.s.',
            stavSubjektu: 'AKTIVNI',
            // akcionari deliberately absent — most a.s. do not publish shareholders in VR
            statutarniOrgany: [{ nazevOrganu: 'představenstvo', clenoveOrganu: [] }],
          },
        ],
      });
    const c = new AresClient();
    const vr = await c.getVrRecord('11122233');
    const owners = extractOwners(vr!);

    expect(owners).toEqual([]);
  });

  it('includes a historical společník with datumZaniku set', async () => {
    handler = () =>
      jsonResponse({
        zaznamy: [
          {
            ico: '99988877',
            obchodniJmeno: 'Firma s Historií s.r.o.',
            stavSubjektu: 'AKTIVNI',
            spolecnici: [
              {
                spolecnik: [
                  {
                    osoba: { fyzickaOsoba: { jmeno: 'Petr', prijmeni: 'Starý' } },
                    podil: [{ velikostPodilu: { hodnota: '100%' } }],
                    datumZapisu: '2010-01-01',
                    datumVymazu: '2020-06-15',
                  },
                ],
              },
            ],
          },
        ],
      });
    const c = new AresClient();
    const vr = await c.getVrRecord('99988877');
    const owners = extractOwners(vr!);

    expect(owners).toHaveLength(1);
    expect(owners[0]).toMatchObject({
      jmeno: 'Petr Starý',
      datumVzniku: '2010-01-01',
      datumZaniku: '2020-06-15',
    });
  });

  it('extracts akcionáři with podíl when present in VR data', () => {
    const vr: AresVrRecord = {
      ico: '55566677',
      obchodniJmeno: 'Malá Akciovka a.s.',
      akcionari: [
        {
          clenoveOrganu: [
            {
              fyzickaOsoba: { jmeno: 'Eva', prijmeni: 'Malá' },
              podil: [{ velikostPodilu: { hodnota: '100%' } }],
              datumZapisu: '2018-03-01',
              datumVymazu: null,
            },
          ],
        },
      ],
    };
    const owners = extractOwners(vr);
    expect(owners).toEqual([
      {
        role: 'akcionar',
        typ: 'FO',
        jmeno: 'Eva Malá',
        nazev: undefined,
        ico: undefined,
        datumNarozeni: undefined,
        podil: { vklad: undefined, splaceno: undefined, velikostPodilu: '100%', text: undefined },
        datumVzniku: '2018-03-01',
        datumZaniku: undefined,
      },
    ]);
  });

  it('returns empty array when the VR record has no spolecnici/akcionari at all', () => {
    const vr: AresVrRecord = { ico: '00000000' };
    expect(extractOwners(vr)).toEqual([]);
  });
});

describe('get_owners MCP tool', () => {
  async function connect(client: AresClient) {
    const server = buildAresServer({ client });
    const mcpClient = new Client({ name: 'owners-test', version: '1' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    await mcpClient.connect(clientTransport);
    return { mcpClient, server };
  }

  it('returns structuredContent + text for an s.r.o. with 2 společníci', async () => {
    const vr: AresVrRecord = {
      ico: '27074358',
      obchodniJmeno: 'Testovací s.r.o.',
      spolecnici: [
        {
          spolecnik: [
            {
              osoba: { fyzickaOsoba: { jmeno: 'Jan', prijmeni: 'Novák' } },
              podil: [{ velikostPodilu: { hodnota: '50%' } }],
              datumZapisu: '2015-01-01',
              datumVymazu: null,
            },
            {
              osoba: { pravnickaOsoba: { ico: '87654321', obchodniJmeno: 'Holding a.s.' } },
              podil: [{ velikostPodilu: { hodnota: '50%' } }],
              datumZapisu: '2015-01-01',
              datumVymazu: null,
            },
          ],
        },
      ],
    };
    const upstream = { getVrRecord: vi.fn().mockResolvedValue(vr) } as unknown as AresClient;
    const { mcpClient, server } = await connect(upstream);
    try {
      const result = await mcpClient.callTool({ name: 'get_owners', arguments: { ico: '27074358' } });
      expect(result.isError).not.toBe(true);
      const structured = result.structuredContent as { found: boolean; vlastnici: unknown[] };
      expect(structured.found).toBe(true);
      expect(structured.vlastnici).toHaveLength(2);
      const content = result.content as Array<{ type: string; text: string }>;
      expect(content[0]?.text).toContain('Jan Novák');
      expect(content[0]?.text).toContain('Holding a.s.');
      expect(content[0]?.text).toContain('IČO 87654321');
    } finally {
      await mcpClient.close();
      await server.close();
    }
  });

  it('returns found:true and an empty list (no error) for an a.s. without akcionáři', async () => {
    const vr: AresVrRecord = {
      ico: '26168685',
      obchodniJmeno: 'Testovací a.s.',
    };
    const upstream = { getVrRecord: vi.fn().mockResolvedValue(vr) } as unknown as AresClient;
    const { mcpClient, server } = await connect(upstream);
    try {
      const result = await mcpClient.callTool({ name: 'get_owners', arguments: { ico: '26168685' } });
      expect(result.isError).not.toBe(true);
      const structured = result.structuredContent as { found: boolean; vlastnici: unknown[] };
      expect(structured.found).toBe(true);
      expect(structured.vlastnici).toEqual([]);
      const text = (result.content as Array<{ type: string; text: string }>).map((b) => b.text).join('\n');
      expect(text).toContain('nemá ve Veřejném rejstříku zveřejněné žádné společníky ani akcionáře');
    } finally {
      await mcpClient.close();
      await server.close();
    }
  });

  it('returns found:false and no CTA overpromise when there is no VR record', async () => {
    const upstream = { getVrRecord: vi.fn().mockResolvedValue(null) } as unknown as AresClient;
    const { mcpClient, server } = await connect(upstream);
    try {
      const result = await mcpClient.callTool({ name: 'get_owners', arguments: { ico: '87654326' } });
      expect(result.isError).not.toBe(true);
      const structured = result.structuredContent as { found: boolean; vlastnici: unknown[] };
      expect(structured.found).toBe(false);
      expect(structured.vlastnici).toEqual([]);
      const text = (result.content as Array<{ type: string; text: string }>).map((b) => b.text).join('\n');
      expect(text).toContain('nemá záznam ve Veřejném rejstříku');
    } finally {
      await mcpClient.close();
      await server.close();
    }
  });

  it('shows a historical společník with its zánik date in the text output', async () => {
    const vr: AresVrRecord = {
      ico: '11122234',
      obchodniJmeno: 'Firma s Historií s.r.o.',
      spolecnici: [
        {
          spolecnik: [
            {
              osoba: { fyzickaOsoba: { jmeno: 'Petr', prijmeni: 'Starý' } },
              podil: [{ velikostPodilu: { hodnota: '100%' } }],
              datumZapisu: '2010-01-01',
              datumVymazu: '2020-06-15',
            },
          ],
        },
      ],
    };
    const upstream = { getVrRecord: vi.fn().mockResolvedValue(vr) } as unknown as AresClient;
    const { mcpClient, server } = await connect(upstream);
    try {
      const result = await mcpClient.callTool({ name: 'get_owners', arguments: { ico: '11122234' } });
      const structured = result.structuredContent as { vlastnici: Array<{ datumZaniku?: string }> };
      expect(structured.vlastnici[0]?.datumZaniku).toBe('2020-06-15');
      const text = (result.content as Array<{ type: string; text: string }>).map((b) => b.text).join('\n');
      expect(text).toContain('Petr Starý');
      expect(text).toContain('zaniklo 2020-06-15');
    } finally {
      await mcpClient.close();
      await server.close();
    }
  });
});
