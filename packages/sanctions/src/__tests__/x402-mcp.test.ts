/**
 * Akceptační test na úrovni skutečného MCP serveru.
 *
 * `server.ts` se ve fázi 3 změnil, takže „nic se nezhoršilo" už není samozřejmé
 * a musí se měřit. Server se staví dvakrát — jednou s branou, jednou bez — a
 * porovnávají se výstupy **byte po bytu**.
 *
 * Testuje se přes skutečného in-process MCP klienta, ne voláním handlerů:
 * zajímá nás, co doopravdy projde přes transport, včetně `_meta`.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SanctionsDb } from '../db.js';
import { SanctionsSearch } from '../search.js';
import { buildSanctionsServer } from '../server.js';
import { MCP_PAYMENT_META_KEY, MCP_PAYMENT_RESPONSE_META_KEY, type X402Gate } from '@czagents/shared/x402';

const ENTITY = {
  id: 'eu-1', source: 'eu' as const, source_list_id: 'eu-1', type: 'entity' as const,
  primary_name: 'Testovaná firma s.r.o.', aliases: ['Testovana firma'],
  ids: [{ type: 'ico', value: '27074358' }],
  programs: ['EU.TEST'], listed_on: '2026-01-01',
} as unknown as Parameters<SanctionsDb['upsertSource']>[1][number];

let dir: string;
let db: SanctionsDb;
let search: SanctionsSearch;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'sanctions-mcp-'));
  db = new SanctionsDb(join(dir, 'sanctions.db'));
  db.upsertSource('eu', [ENTITY]);
  search = new SanctionsSearch(db);
});
afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

const requirements = {
  scheme: 'exact', network: 'eip155:84532' as const, asset: '0x036c', amount: '5000',
  payTo: '0x1111', maxTimeoutSeconds: 60, extra: {},
};

const gateStub = (over: Partial<X402Gate> = {}): X402Gate => ({
  offer: vi.fn().mockReturnValue({ resource: 'r:1', requirements }),
  redeem: vi.fn().mockResolvedValue({
    released: true, settlement: { success: true, transaction: '0xtx', network: 'eip155:84532' },
  }),
  ...over,
});

async function connect(x402?: X402Gate) {
  const server = buildSanctionsServer({ db, search, x402 });
  const client = new Client({ name: 'test', version: '0' }, { capabilities: {} });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(a), client.connect(b)]);
  return client;
}

/** Pět nástrojů, které existovaly před x402 a nesmí se změnit. */
const EXISTING_CALLS = [
  { name: 'search_person', arguments: { name: 'Testovaná firma' } },
  { name: 'search_entity', arguments: { name: 'Testovaná firma s.r.o.' } },
  { name: 'check_ico', arguments: { ico: '27074358' } },
  { name: 'get_listing', arguments: { id: 'eu-1' } },
  { name: 'list_recent_updates', arguments: { since: '2020-01-01' } },
];

describe('TVRDÁ PODMÍNKA — existujících pět nástrojů se nemění', () => {
  it('vrací byte-shodné výsledky se zapnutou i vypnutou bránou', async () => {
    const without = await connect(undefined);
    const withGate = await connect(gateStub());

    for (const call of EXISTING_CALLS) {
      const a = await without.callTool(call);
      const b = await withGate.callTool(call);
      // `list_recent_updates` nese `until: new Date()`, což se mezi voláními
      // liší — porovnává se proto obsah bez časového razítka. Všechno ostatní
      // musí sedět doslova.
      // Razítko je uvnitř escapovaného JSON textu (`\"until\": \"...\"`),
      // proto ten tvar regexu — na vnějším JSONu by nic netrefil.
      const strip = (r: unknown) =>
        JSON.stringify(r).replace(/\\?"until\\?"\s*:\s*\\?"[^"\\]+\\?"/g, '"until":"<ts>"');
      expect(strip(b), `nástroj ${call.name} se změnil`).toBe(strip(a));
    }
  });

  it('bez brány se placený nástroj vůbec nenabízí', async () => {
    const tools = await (await connect(undefined)).listTools();
    const names = tools.tools.map((t) => t.name);
    expect(names).not.toContain('rescreen_portfolio');
    expect(names).toEqual(expect.arrayContaining(EXISTING_CALLS.map((c) => c.name)));
  });

  it('se zapnutou bránou přibývá právě jeden nástroj, žádný nemizí', async () => {
    const before = (await (await connect(undefined)).listTools()).tools.map((t) => t.name).sort();
    const after = (await (await connect(gateStub())).listTools()).tools.map((t) => t.name).sort();
    expect(after.filter((n) => !before.includes(n))).toEqual(['rescreen_portfolio']);
    expect(before.filter((n) => !after.includes(n))).toEqual([]);
  });
});

describe('placený nástroj přes skutečný MCP transport', () => {
  it('bez platby vrací isError a PaymentRequired v obou formátech', async () => {
    const client = await connect(gateStub());
    const result = await client.callTool({
      name: 'rescreen_portfolio',
      arguments: { subjects: [{ ref: 'a', ico: '27074358' }], since: '2026-07-01' },
    }) as { isError?: boolean; content: Array<{ text: string }>; structuredContent?: unknown };

    expect(result.isError).toBe(true);
    const fromText = JSON.parse(result.content[0]!.text);
    expect(fromText).toEqual(result.structuredContent);
    expect(fromText).toMatchObject({ x402Version: 2 });
  });

  it('se zaplacením vydá data a settlement dorazí v _meta', async () => {
    const client = await connect(gateStub());
    const result = await client.callTool({
      name: 'rescreen_portfolio',
      arguments: { subjects: [{ ref: 'a', ico: '27074358' }], since: '2026-07-01' },
      _meta: { [MCP_PAYMENT_META_KEY]: { x402Version: 2 } },
    }) as { content: Array<{ text: string }>; _meta?: Record<string, unknown>; isError?: boolean };

    expect(result.isError).toBeFalsy();
    expect(JSON.parse(result.content[0]!.text)).toHaveProperty('summary.subjects_screened', 1);
    expect(result._meta?.[MCP_PAYMENT_RESPONSE_META_KEY]).toMatchObject({ transaction: '0xtx' });
  });

  it('neúspěšná platba nevydá data ani přes transport', async () => {
    const gate = gateStub({
      redeem: vi.fn().mockResolvedValue({ released: false, code: 'verify_failed', reason: 'neplatný podpis' }),
    });
    const client = await connect(gate);
    const result = await client.callTool({
      name: 'rescreen_portfolio',
      arguments: { subjects: [{ ref: 'a', ico: '27074358' }], since: '2026-07-01' },
      _meta: { [MCP_PAYMENT_META_KEY]: { x402Version: 2 } },
    }) as { isError?: boolean; content: Array<{ text: string }> };

    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.content)).not.toContain('subjects_screened');
  });
});
