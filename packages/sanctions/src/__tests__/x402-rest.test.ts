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
import { createRestRateLimiter, createQuotaGuard, TokenStore } from '@czagents/shared';
import { SanctionsDb } from '../db.js';
import { SanctionsSearch } from '../search.js';
import { handleSanctionsRest } from '../http.js';
import { handleX402Rescreen, resourceIdFor } from '../x402-rest.js';
import { MAX_PORTFOLIO_SUBJECTS_X402 } from '../rescreen.js';
import { loadX402Config, createX402Gate, type X402Gate, type Facilitator } from '@czagents/shared/x402';

/** Nikdy skutečně nevolaná — testy níž nechodí cestou, kde by na ni gate sáhl. */
const unusedFacilitator: Facilitator = {
  supported: vi.fn(() => { throw new Error('facilitator se v tomhle testu nemá volat'); }),
  verify: vi.fn(() => { throw new Error('facilitator se v tomhle testu nemá volat'); }),
  settle: vi.fn(() => { throw new Error('facilitator se v tomhle testu nemá volat'); }),
};

/** Bez limitu — pro testy, které limiter samy neprověřují. */
const passLimiter: ReturnType<typeof createRestRateLimiter> = () => true;

function withSocket(req: IncomingMessage, remoteAddress: string): IncomingMessage {
  (req as unknown as { socket: { remoteAddress: string } }).socket = { remoteAddress };
  return req;
}

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
    const handled = await handleX402Rescreen(fakeReq('POST', '/v1/sanctions/rescreen'), res, { db, gate: null, limiter: passLimiter });
    expect(handled).toBe(true);
    expect(captured.status).toBe(404);
  });

  it('cizí cesty nechává projít dál — existující REST se nemění', async () => {
    for (const path of ['/v1/sanctions/check?ico=27074358', '/health', '/metrics', '/mcp']) {
      const { res } = fakeRes();
      const handled = await handleX402Rescreen(fakeReq('GET', path), res, { db, gate: gateStub(), limiter: passLimiter });
      expect(handled, `cesta ${path} nesmí být pohlcena`).toBe(false);
    }
  });
});

describe('placený endpoint — bez platby vrací 402 podle x402 v2', () => {
  it('requirements jsou v HLAVIČCE PAYMENT-REQUIRED, ne jen v těle', async () => {
    const { res, captured } = fakeRes();
    await handleX402Rescreen(
      fakeReq('POST', '/v1/sanctions/rescreen', {}, { subjects: [{ ref: 'a', ico: '27074358' }], since: '2026-07-01' }),
      res, { db, gate: gateStub(), limiter: passLimiter },
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
      await handleX402Rescreen(fakeReq('POST', '/v1/sanctions/rescreen', {}, body), res, { db, gate: gateStub(), limiter: passLimiter });
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
    await handleX402Rescreen(fakeReq('POST', '/v1/sanctions/rescreen', paidHeaders, body), res, { db, gate, limiter: passLimiter });
    expect(captured.status).toBe(402);
    expect(JSON.parse(captured.body)).toMatchObject({ error: 'payment_failed', code: 'settle_failed' });
    // Nejdůležitější: v těle nesmí být výsledek screeningu.
    expect(captured.body).not.toContain('subjects_screened');
  });

  it('úspěšná platba vydá data a vrátí settlement v hlavičce', async () => {
    db.upsertSource('eu', [ENTITY]);
    const gate = gateStub();
    const { res, captured } = fakeRes();
    await handleX402Rescreen(fakeReq('POST', '/v1/sanctions/rescreen', paidHeaders, body), res, { db, gate, limiter: passLimiter });
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
  /**
   * Předchozí verze tohohle testu nastavovala `process.env.X402_ENABLED` a
   * porovnávala výstup `search.searchByIco()` atd. — kód, který ten env
   * proměnnou vůbec nečte. Test nemohl spadnout, ať se pokazí cokoli
   * (divadlo). Poctivá verze pošle skutečný požadavek přes SKUTEČNÉ produkční
   * funkce ve STEJNÉM pořadí jako `main()` v `http.ts` (`handleX402Rescreen`
   * → `handleSanctionsRest`), jednou se skutečnou branou (reálný
   * `loadX402Config`+`createX402Gate`), jednou bez — a porovná byte po bytu,
   * stejně jako `x402-mcp.test.ts` dělá pro MCP nástroje.
   */
  const testnetEnv = (): NodeJS.ProcessEnv => ({
    X402_ENABLED: 'true',
    X402_NETWORK: 'eip155:84532',
    X402_ASSET: '0x036CbD53842c5426634e7929541eC2318f3dCF7e',
    X402_PAY_TO: '0x1111111111111111111111111111111111111111',
    X402_FACILITATOR_URL: 'https://x402.org/facilitator',
    X402_PRICE_USD: '0.005',
  });

  async function dispatch(
    gate: X402Gate | null,
    req: IncomingMessage,
    res: ServerResponse,
    deps: { search: SanctionsSearch; limiter: ReturnType<typeof createRestRateLimiter>; quota: ReturnType<typeof createQuotaGuard> },
  ): Promise<void> {
    if (await handleX402Rescreen(req, res, { db, gate, limiter: deps.limiter })) return;
    await handleSanctionsRest(req, res, deps.search, deps.limiter, deps.quota);
  }

  it('/v1/sanctions/check je byte-shodné se zapnutou i vypnutou branou x402', async () => {
    db.upsertSource('eu', [ENTITY]);
    const search = new SanctionsSearch(db);
    const tokenStore = new TokenStore(join(dir, 'tokens.db'));
    const quota = createQuotaGuard({ store: tokenStore, service: 'sanctions', allowAnonymous: true });

    const call = async (gate: X402Gate | null) => {
      const req = withSocket(fakeReq('GET', '/v1/sanctions/check?ico=27074358'), '203.0.113.1');
      const { res, captured } = fakeRes();
      await dispatch(gate, req, res, { search, limiter: createRestRateLimiter(), quota });
      // `fetched_at` je čas requestu — normalizuje se pryč, jinak by dva reálné
      // requesty nikdy nemohly být doslovně shodné.
      return { status: captured.status, body: captured.body.replace(/"fetched_at":"[^"]+"/, '"fetched_at":"<ts>"') };
    };

    const withoutGate = await call(null);
    const realGate = createX402Gate(loadX402Config(testnetEnv())!, unusedFacilitator);
    const withGate = await call(realGate);

    expect(withGate).toEqual(withoutGate);
    tokenStore.close();
  });
});

describe('placený endpoint — dávka je omezená cenou, ne 500 z tokenové cesty', () => {
  const paidHeaders = { 'payment-signature': Buffer.from(JSON.stringify({ x402Version: 2 }), 'utf8').toString('base64') };

  it('dávka nad x402 stropem se odmítne srozumitelnou chybou, data se NEVYDAJÍ (i když je zaplaceno)', async () => {
    const subjects = Array.from({ length: MAX_PORTFOLIO_SUBJECTS_X402 + 1 }, (_, i) => ({ ref: `c${i}`, name: `P${i}` }));
    const body = { subjects, since: Date.now() - 86_400_000 };
    const gate = gateStub();
    const { res, captured } = fakeRes();
    await handleX402Rescreen(fakeReq('POST', '/v1/sanctions/rescreen', paidHeaders, body), res, { db, gate, limiter: passLimiter });

    expect(captured.status).toBe(400);
    const parsed = JSON.parse(captured.body);
    expect(parsed.error).toBe('invalid_request');
    expect(parsed.message).toMatch(/over the cap of 11/);
    expect(parsed.paid).toBe(true);
    // Ticho by znamenalo, že si zákazník myslí, že proškrtal celou dávku —
    // žádný výsledek screeningu smí uniknout ven.
    expect(captured.body).not.toContain('subjects_screened');
  });

  it('dávka o 500 subjektech (dřívější token cap) na x402 cestě neprojde — díra je zavřená', async () => {
    const subjects = Array.from({ length: 500 }, (_, i) => ({ ref: `c${i}`, name: `P${i}` }));
    const body = { subjects, since: Date.now() - 86_400_000 };
    const gate = gateStub();
    const { res, captured } = fakeRes();
    await handleX402Rescreen(fakeReq('POST', '/v1/sanctions/rescreen', paidHeaders, body), res, { db, gate, limiter: passLimiter });

    expect(captured.status).toBe(400);
    expect(JSON.parse(captured.body).message).toMatch(/over the cap of 11/);
  });

  it('dávka přesně na x402 stropu projde', async () => {
    const subjects = Array.from({ length: MAX_PORTFOLIO_SUBJECTS_X402 }, (_, i) => ({ ref: `c${i}`, name: `P${i}` }));
    const body = { subjects, since: Date.now() - 86_400_000 };
    const gate = gateStub();
    const { res, captured } = fakeRes();
    await handleX402Rescreen(fakeReq('POST', '/v1/sanctions/rescreen', paidHeaders, body), res, { db, gate, limiter: passLimiter });

    expect(captured.status).toBe(200);
    expect(JSON.parse(captured.body)).toHaveProperty('summary.subjects_screened', MAX_PORTFOLIO_SUBJECTS_X402);
  });
});

describe('placený endpoint — sdílí rate limit s existujícím REST (Úkol 3)', () => {
  it('neplacené 402 nabídky jsou omezené — před opravou limiter vůbec neběžel', async () => {
    // max: 2 — třetí požadavek ze stejné IP musí narazit na 429, ne na další 402.
    // Tohle je test, který by BEZ opravy `handleX402Rescreen` (chybějící volání
    // limiteru) nikdy nevrátil 429 — útočník by mohl generovat nabídky bez konce.
    const limiter = createRestRateLimiter({ max: 2, windowMs: 60_000 });
    const gate = gateStub();
    const body = { subjects: [], since: '2026-07-01' };

    const hit = async () => {
      const req = withSocket(fakeReq('POST', '/v1/sanctions/rescreen', {}, body), '198.51.100.7');
      const { res, captured } = fakeRes();
      await handleX402Rescreen(req, res, { db, gate, limiter });
      return captured.status;
    };

    expect(await hit()).toBe(402);
    expect(await hit()).toBe(402);
    expect(await hit()).toBe(429);
  });
});
