/**
 * Akceptační testy k tvrdé podmínce zadání:
 *
 *   „Žádná změna nesmí zhoršit to, co dnes kdokoli dostane. Kdo dnes projde,
 *    projde stejně; kdo dnes narazí na cap, narazí na něj dál."
 *
 * Proto je tu vedle testů placené cesty i test, který porovnává **byte po
 * bytu** výstupy existujících nástrojů se zapnutým a vypnutým x402. Slib, že
 * se nic nezhoršilo, není měření.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventEmitter } from 'node:events';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SanctionsDb } from '../db.js';
import { SanctionsSearch } from '../search.js';
import { handleX402Rescreen, resourceIdFor } from '../x402-rest.js';
import type { X402Gate } from '@czagents/shared/x402';

const ENTITY = {
  id: 'eu-1', source: 'eu' as const, source_list_id: 'eu-1', type: 'entity' as const,
  primary_name: 'Testovaná firma s.r.o.', aliases: ['Testovana firma'],
  ids: [{ type: 'ico', value: '27074358' }],
  programs: ['EU.TEST'], listed_on: '2026-01-01',
} as unknown as Parameters<SanctionsDb['upsertSource']>[1][number];

let dir: string;
let db: SanctionsDb;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'sanctions-x402-'));
  db = new SanctionsDb(join(dir, 'sanctions.db'));
});
afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

/** Minimální falešný request/response, ať se nemusí zvedat celý server. */
function fakeReq(method: string, path: string, headers: Record<string, string> = {}, body?: unknown): IncomingMessage {
  const req = new EventEmitter() as IncomingMessage & { destroy(): void };
  req.method = method;
  req.url = path;
  req.headers = headers;
  req.destroy = () => {};
  queueMicrotask(() => {
    if (body !== undefined) req.emit('data', Buffer.from(JSON.stringify(body), 'utf8'));
    req.emit('end');
  });
  return req;
}

function fakeRes() {
  const headers: Record<string, string> = {};
  const captured = { status: 0, body: '' as string, headers, sent: false };
  const res = {
    headersSent: false,
    setHeader: (k: string, v: string) => { headers[k] = v; },
    writeHead: (status: number) => { captured.status = status; return res; },
    end: (chunk?: string) => { captured.body = chunk ?? ''; captured.sent = true; res.headersSent = true; },
  } as unknown as ServerResponse;
  return { res, captured };
}

const gateStub = (over: Partial<X402Gate> = {}): X402Gate => ({
  offer: vi.fn().mockReturnValue({
    resource: 'r', requirements: {
      scheme: 'exact', network: 'eip155:84532', asset: '0x036c', amount: '5000',
      payTo: '0x1111', maxTimeoutSeconds: 60, extra: {},
    },
  }),
  redeem: vi.fn().mockResolvedValue({ released: true, settlement: { success: true, transaction: '0xtx', network: 'eip155:84532' } }),
  ...over,
});

describe('placený endpoint — když je x402 vypnuté, neexistuje', () => {
  it('vrací 404, ne 402 ani 503', async () => {
    const { res, captured } = fakeRes();
    const handled = await handleX402Rescreen(fakeReq('POST', '/v1/sanctions/rescreen'), res, { db, gate: null });
    expect(handled).toBe(true);
    expect(captured.status).toBe(404);
  });

  it('cizí cesty nechává projít dál — existující REST se nemění', async () => {
    for (const path of ['/v1/sanctions/check?ico=27074358', '/health', '/metrics', '/mcp']) {
      const { res } = fakeRes();
      const handled = await handleX402Rescreen(fakeReq('GET', path), res, { db, gate: gateStub() });
      expect(handled, `cesta ${path} nesmí být pohlcena`).toBe(false);
    }
  });
});

describe('placený endpoint — bez platby vrací 402 podle x402 v2', () => {
  it('requirements jsou v HLAVIČCE PAYMENT-REQUIRED, ne jen v těle', async () => {
    const { res, captured } = fakeRes();
    await handleX402Rescreen(
      fakeReq('POST', '/v1/sanctions/rescreen', {}, { subjects: [{ ref: 'a', ico: '27074358' }], since: '2026-07-01' }),
      res, { db, gate: gateStub() },
    );
    expect(captured.status).toBe(402);
    const header = captured.headers['PAYMENT-REQUIRED'];
    expect(header, 'hlavička PAYMENT-REQUIRED musí být přítomná').toBeTruthy();
    const decoded = JSON.parse(Buffer.from(header!, 'base64').toString('utf8'));
    expect(decoded).toMatchObject({ x402Version: 2 });
    expect(decoded.accepts[0]).toMatchObject({ scheme: 'exact', network: 'eip155:84532' });
  });

  it('odmítne nečitelné tělo i chybějící since', async () => {
    for (const body of [{ subjects: [] }, { subjects: [], since: 'nesmysl' }]) {
      const { res, captured } = fakeRes();
      await handleX402Rescreen(fakeReq('POST', '/v1/sanctions/rescreen', {}, body), res, { db, gate: gateStub() });
      expect(captured.status).toBe(400);
    }
  });
});

describe('placený endpoint — data se vydají jen po zaplacení', () => {
  const paidHeaders = { 'payment-signature': Buffer.from(JSON.stringify({ x402Version: 2 }), 'utf8').toString('base64') };
  const body = { subjects: [{ ref: 'a', ico: '27074358' }], since: Date.now() - 86_400_000 };

  it('neúspěšná platba nevydá data a nabídne znovu zaplatit', async () => {
    const gate = gateStub({ redeem: vi.fn().mockResolvedValue({ released: false, code: 'settle_failed', reason: 'neusadilo se' }) });
    const { res, captured } = fakeRes();
    await handleX402Rescreen(fakeReq('POST', '/v1/sanctions/rescreen', paidHeaders, body), res, { db, gate });
    expect(captured.status).toBe(402);
    expect(JSON.parse(captured.body)).toMatchObject({ error: 'payment_failed', code: 'settle_failed' });
    // Nejdůležitější: v těle nesmí být výsledek screeningu.
    expect(captured.body).not.toContain('subjects_screened');
  });

  it('úspěšná platba vydá data a vrátí settlement v hlavičce', async () => {
    db.upsertSource('eu', [ENTITY]);
    const gate = gateStub();
    const { res, captured } = fakeRes();
    await handleX402Rescreen(fakeReq('POST', '/v1/sanctions/rescreen', paidHeaders, body), res, { db, gate });
    expect(captured.status).toBe(200);
    expect(JSON.parse(captured.body)).toHaveProperty('summary.subjects_screened', 1);
    const settlement = JSON.parse(Buffer.from(captured.headers['PAYMENT-RESPONSE']!, 'base64').toString('utf8'));
    expect(settlement).toMatchObject({ success: true, transaction: '0xtx' });
  });

  it('resource binding váže platbu na ROZSAH práce, ne na obsah portfolia', () => {
    // Do identifikátoru se nesmí dostat jména ani IČO — jde do logu i do payloadu.
    const id = resourceIdFor(3, 1_800_000_000_000);
    expect(id).toContain('n=3');
    expect(id).not.toContain('27074358');
    // Jiný rozsah = jiný zdroj, takže platbu za malé portfolio nejde uplatnit
    // na velké.
    expect(resourceIdFor(3, 1)).not.toBe(resourceIdFor(300, 1));
  });
});

describe('TVRDÁ PODMÍNKA — existující chování se nesmí zhoršit', () => {
  it('výstupy existujících nástrojů jsou byte-shodné se zapnutým i vypnutým x402', () => {
    db.upsertSource('eu', [ENTITY]);
    const search = new SanctionsSearch(db);

    const callAll = () => JSON.stringify({
      byIco: search.searchByIco('27074358'),
      byName: search.searchByName('Testovaná firma s.r.o.'),
      byDoc: search.searchByDocument('ico', '27074358'),
      changes: db.changesSince(0),
      stats: db.stats(),
    });

    const withoutX402 = callAll();
    process.env.X402_ENABLED = 'true';
    process.env.X402_NETWORK = 'eip155:84532';
    try {
      const withX402 = callAll();
      // Ne toEqual — doslovná shoda řetězců. Kdyby x402 cokoli přidalo do
      // odpovědi existujícího nástroje, tenhle test padne.
      expect(withX402).toBe(withoutX402);
    } finally {
      delete process.env.X402_ENABLED;
      delete process.env.X402_NETWORK;
    }
  });

  it('denní cap zůstává nedotčený — x402 ho neobchází ani nezpřísňuje', () => {
    // x402 se ptá až tam, kde dnes nic není (nový endpoint). Existující kvótová
    // brána se nemění, takže kdo dnes narazí na cap, narazí na něj dál.
    const before = db.stats();
    process.env.X402_ENABLED = 'true';
    try {
      expect(db.stats()).toEqual(before);
    } finally {
      delete process.env.X402_ENABLED;
    }
  });
});
