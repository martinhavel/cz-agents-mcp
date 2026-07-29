/**
 * Payqr je v x402 testu **kontrolní vzorek jiného typu plnění**.
 *
 * Sanctions vrací jen text. Payqr vrací obrázky. Otázka, kterou tenhle soubor
 * měří, tedy není „umí payqr vybrat peníze", ale:
 *
 *   přežije `_meta["x402/payment-response"]` výsledek, ve kterém jsou image bloky?
 *
 * Kdyby ne, znamenalo by to, že MCP vazba funguje jen pro textová plnění — a to
 * by byl podstatný nález, protože většina zajímavých placených nástrojů vrací
 * něco jiného než text.
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { describe, expect, it, vi } from 'vitest';
import { Jimp } from 'jimp';
import jsQrModule from 'jsqr';
import { buildPayqrServer } from '../server.js';
import { MCP_PAYMENT_META_KEY, MCP_PAYMENT_RESPONSE_META_KEY, type X402Gate } from '@czagents/shared/x402';

const IBAN = 'CZ6508000000192000145399';

const requirements = {
  scheme: 'exact', network: 'eip155:84532' as const, asset: '0x036c', amount: '5000',
  payTo: '0x1111', maxTimeoutSeconds: 60, extra: {},
};

const gateStub = (over: Partial<X402Gate> = {}): X402Gate => ({
  offer: vi.fn().mockReturnValue({ resource: 'payqr:batch:n=2', requirements }),
  redeem: vi.fn().mockResolvedValue({
    released: true, settlement: { success: true, transaction: '0xtx', network: 'eip155:84532' },
  }),
  ...over,
});

async function connect(x402?: X402Gate) {
  const server = buildPayqrServer(x402);
  const client = new Client({ name: 'test', version: '0' }, { capabilities: {} });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(a), client.connect(b)]);
  return client;
}


/**
 * Typované volání nástroje.
 *
 * Bez něj by se psalo `await client.callTool({...}) as T`, jenže u víceřádkového
 * volání vloží parser implicitní středník před `as` a soubor se nepřeloží.
 * Pomocná funkce tu past odstraňuje na jednom místě.
 */
type ToolContent = Array<{ type: string; text?: string; data?: string }>;
interface ToolReply { content: ToolContent; _meta?: Record<string, unknown>; isError?: boolean; structuredContent?: unknown }

type JsQr = (
  data: Uint8ClampedArray,
  width: number,
  height: number,
) => { data: string } | null;

const jsQR = (typeof jsQrModule === 'function' ? jsQrModule : jsQrModule.default) as JsQr;

async function decodePngBlock(data: string): Promise<string | null> {
  // Buffer.from(base64) is deliberately permissive, so first require a canonical
  // base64 representation. This catches truncated/corrupted MCP image blocks.
  expect(data).toMatch(/^[A-Za-z0-9+/]+={0,2}$/);
  const png = Buffer.from(data, 'base64');
  expect(png.subarray(0, 8)).toEqual(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  expect(png.toString('base64')).toBe(data);

  const image = await Jimp.read(png);
  const decoded = jsQR(
    new Uint8ClampedArray(image.bitmap.data),
    image.bitmap.width,
    image.bitmap.height,
  );
  return decoded?.data ?? null;
}
async function call(client: Client, params: Parameters<Client['callTool']>[0]): Promise<ToolReply> {
  return (await client.callTool(params)) as unknown as ToolReply;
}

const batchArgs = {
  payments: [
    { ref: 'faktura-1', iban: IBAN, amount: 1500, message: 'Faktura 1' },
    { ref: 'faktura-2', iban: IBAN, amount: 2500, message: 'Faktura 2' },
  ],
};

describe('TVRDÁ PODMÍNKA — čtyři existující nástroje se nemění', () => {
  it('bez brány se dávkový nástroj vůbec nenabízí', async () => {
    const names = (await (await connect(undefined)).listTools()).tools.map((t) => t.name);
    expect(names).not.toContain('qr_payment_batch');
    expect(names).toEqual(expect.arrayContaining(['qr_payment', 'qr_text', 'qr_wifi', 'qr_vcard']));
  });

  it('se zapnutou bránou přibývá právě jeden nástroj, žádný nemizí', async () => {
    const before = (await (await connect(undefined)).listTools()).tools.map((t) => t.name).sort();
    const after = (await (await connect(gateStub())).listTools()).tools.map((t) => t.name).sort();
    expect(after.filter((n) => !before.includes(n))).toEqual(['qr_payment_batch']);
    expect(before.filter((n) => !after.includes(n))).toEqual([]);
  });

  it('qr_payment vrací se zapnutou i vypnutou bránou totéž', async () => {
    const args = { name: 'qr_payment', arguments: { iban: IBAN, amount: 1500, message: 'Test' } };
    const a = await (await connect(undefined)).callTool(args);
    const b = await (await connect(gateStub())).callTool(args);
    expect(JSON.stringify(b)).toBe(JSON.stringify(a));
  });
});

describe('KONTROLNÍ VZOREK — _meta přežije výsledek s image bloky', () => {
  it('zaplacená dávka vrátí obrázky I settlement v _meta', async () => {
    const client = await connect(gateStub());
    const result = await call(client, {
      name: 'qr_payment_batch',
      arguments: batchArgs,
      _meta: { [MCP_PAYMENT_META_KEY]: { x402Version: 2 } },
    });

    expect(result.isError).toBeFalsy();

    // 1) Obrázky jsou součástí plnění, ne příloha.
    const images = result.content.filter((c) => c.type === 'image');
    expect(images).toHaveLength(2);
    expect(images.every((image) => image.data && image.data.length > 100)).toBe(true);

    // 2) A settlement přesto dorazil — tohle je ta odpověď, kvůli které payqr
    //    v testu je.
    expect(result._meta?.[MCP_PAYMENT_RESPONSE_META_KEY]).toMatchObject({ transaction: '0xtx' });

    // 3) Text se souhrnem sedí a settlement v něm NENÍ.
    const summary = JSON.parse(result.content.find((c) => c.type === 'text')!.text!);
    expect(summary).toMatchObject({ requested: 2, generated: 2, failed: 0 });
    expect(images).toHaveLength(summary.generated);
    const expectedPayloads = summary.results
      .filter((item: { ok: boolean }) => item.ok)
      .map((item: { payload: string }) => item.payload);
    const decodedPayloads = await Promise.all(images.map((image) => decodePngBlock(image.data!)));
    expect(decodedPayloads).toEqual(expectedPayloads);
    expect(summary.results.every((item: { self_verified?: boolean }) => item.self_verified === true)).toBe(true);
    expect(JSON.stringify(result.content)).not.toContain('0xtx');
  });

  it('bez platby nevyrobí ani jeden QR', async () => {
    const client = await connect(gateStub());
    const result = await call(client, { name: 'qr_payment_batch', arguments: batchArgs });

    expect(result.isError).toBe(true);
    expect(result.content.filter((c) => c.type === 'image')).toHaveLength(0);
    const fromText = JSON.parse(result.content[0]!.text!);
    expect(fromText).toEqual(result.structuredContent);
    expect(fromText).toMatchObject({ x402Version: 2 });
  });

  it('jedna vadná platba nezruší celou zaplacenou dávku', async () => {
    // Zákazník za dávku zaplatil. Shodit ji kvůli jednomu špatnému IBANu by
    // znamenalo vzít peníze a nedat nic.
    const client = await connect(gateStub());
    const result = await call(client, {
      name: 'qr_payment_batch',
      arguments: { payments: [
        { ref: 'ok', iban: IBAN, amount: 100 },
        { ref: 'spatny', iban: 'CZ0000000000000000000000', amount: 200 },
      ] },
      _meta: { [MCP_PAYMENT_META_KEY]: { x402Version: 2 } },
    });

    const summary = JSON.parse(result.content.find((c) => c.type === 'text')!.text!);
    expect(summary.generated).toBe(1);
    expect(summary.failed).toBe(1);
    expect(summary.results.find((r: { ref: string }) => r.ref === 'spatny').ok).toBe(false);
  });

  it('resource binding váže platbu na velikost dávky, ne na IBANy', async () => {
    const gate = gateStub();
    const client = await connect(gate);
    await client.callTool({
      name: 'qr_payment_batch', arguments: batchArgs,
      _meta: { [MCP_PAYMENT_META_KEY]: { x402Version: 2 } },
    });
    const resource = (gate.redeem as ReturnType<typeof vi.fn>).mock.calls[0]![0].expectedResource;
    expect(resource).toBe('payqr:batch:n=2');
    expect(resource).not.toContain(IBAN);
  });
});
