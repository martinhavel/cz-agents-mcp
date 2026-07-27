import { describe, expect, it, vi } from 'vitest';
import { createX402Gate, priceToAtomic } from '../gate.js';
import { loadX402Config } from '../config.js';
import { createMemoryReplayStore } from '../checks.js';
import type { Facilitator } from '../facilitator.js';

const NOW = 1_800_000_000_000;
const nowSec = Math.floor(NOW / 1000);
const PAY_TO = '0x1111111111111111111111111111111111111111';
const ASSET = '0x036CbD53842c5426634e7929541eC2318f3dCF7e';
const NETWORK = 'eip155:84532';

const config = (over: Record<string, string> = {}) =>
  loadX402Config({
    X402_ENABLED: 'true',
    X402_NETWORK: NETWORK,
    X402_ASSET: ASSET,
    X402_PAY_TO: PAY_TO,
    X402_FACILITATOR_URL: 'https://x402.org/facilitator',
    X402_PRICE_USD: '0.005',
    ...over,
  })!;

/** Kanonická URL zdroje — klient vrací celý `ResourceInfo`, ne řetězec. */
const resourceUrl = (r: string) => `https://cz-agents.dev/x402/${encodeURIComponent(r)}`;

/** Payload, který projde všemi sedmi kontrolami. */
const goodPayload = (resource: string, over: Record<string, unknown> = {}) => ({
  x402Version: 2,
  resource: { url: resourceUrl(resource), description: 'x', mimeType: 'application/json' },
  accepted: { network: NETWORK, asset: ASSET },
  payload: {
    authorization: {
      from: '0x2222222222222222222222222222222222222222',
      to: PAY_TO,
      value: priceToAtomic(0.005),
      validAfter: String(nowSec - 60),
      validBefore: String(nowSec + 600),
      nonce: '0x' + 'ab'.repeat(32),
    },
  },
  ...over,
});

const facilitator = (over: Partial<Facilitator> = {}): Facilitator => ({
  supported: vi.fn().mockResolvedValue({ kinds: [] }),
  verify: vi.fn().mockResolvedValue({ isValid: true, payer: '0xAe59' }),
  settle: vi.fn().mockResolvedValue({ success: true, transaction: '0xtx', network: NETWORK }),
  ...over,
});

describe('cena v atomických jednotkách', () => {
  it('nepočítá přes plovoucí čárku', () => {
    // 0.005 * 1e6 v Number vrátí 4999.999999999999.
    expect(priceToAtomic(0.005)).toBe('5000');
    expect(priceToAtomic(1)).toBe('1000000');
    expect(priceToAtomic(0.000001)).toBe('1');
    expect(priceToAtomic(123.456789)).toBe('123456789');
  });
});

describe('brána — data se vydají jen po úspěšném settlementu', () => {
  it('platný payload projde a vrátí transakci', async () => {
    const gate = createX402Gate(config(), facilitator());
    const result = await gate.redeem({ payload: goodPayload('t:1'), expectedResource: 't:1', now: NOW });
    expect(result.released).toBe(true);
    if (result.released) expect(result.settlement?.transaction).toBe('0xtx');
  });

  it('settle proběhne PŘED vydáním — a když selže, data nejdou ven', async () => {
    const f = facilitator({ settle: vi.fn().mockResolvedValue({ success: false, errorReason: 'insufficient_funds', transaction: '', network: NETWORK }) });
    const gate = createX402Gate(config(), f);
    const result = await gate.redeem({ payload: goodPayload('t:1'), expectedResource: 't:1', now: NOW });
    expect(result).toMatchObject({ released: false, code: 'settle_failed' });
  });

  it('nejasný stav settlementu se čte jako nezaplaceno', async () => {
    // Výjimka při settle znamená, že platba mohla projít i neprojít. Z dvou
    // špatných možností je nevydat menší zlo — nevydaná data jdou vydat
    // později, vydaná se nedají vzít zpátky.
    const f = facilitator({ settle: vi.fn().mockRejectedValue(new Error('timeout')) });
    const gate = createX402Gate(config(), f);
    const result = await gate.redeem({ payload: goodPayload('t:1'), expectedResource: 't:1', now: NOW });
    expect(result).toMatchObject({ released: false, code: 'settlement_unknown' });
  });

  it('nedostupný facilitátor nevydá data', async () => {
    const f = facilitator({ verify: vi.fn().mockRejectedValue(new Error('ECONNREFUSED')) });
    const gate = createX402Gate(config(), f);
    const result = await gate.redeem({ payload: goodPayload('t:1'), expectedResource: 't:1', now: NOW });
    expect(result).toMatchObject({ released: false, code: 'facilitator_unavailable' });
  });

  it('facilitátor platbu neuzná → data nejdou ven', async () => {
    const f = facilitator({ verify: vi.fn().mockResolvedValue({ isValid: false, invalidReason: 'invalid_signature' }) });
    const gate = createX402Gate(config(), f);
    const result = await gate.redeem({ payload: goodPayload('t:1'), expectedResource: 't:1', now: NOW });
    expect(result).toMatchObject({ released: false, code: 'verify_failed' });
  });
});

describe('brána — pořadí operací', () => {
  it('NAŠE kontroly běží PŘED facilitátorem', async () => {
    // Payload pro jiný zdroj nesmí facilitátora vůbec obtěžovat: víme, že
    // patří jinam, a volání by stálo čas i kvótu.
    const f = facilitator();
    const gate = createX402Gate(config(), f);
    const result = await gate.redeem({ payload: goodPayload('t:levny'), expectedResource: 't:drahy', now: NOW });
    expect(result).toMatchObject({ released: false, code: 'resource_mismatch' });
    expect(f.verify).not.toHaveBeenCalled();
    expect(f.settle).not.toHaveBeenCalled();
  });

  it('replay se zastaví dřív, než se sáhne na facilitátora', async () => {
    const f = facilitator();
    const gate = createX402Gate(config(), f);
    await gate.redeem({ payload: goodPayload('t:1'), expectedResource: 't:1', now: NOW });
    expect(f.settle).toHaveBeenCalledTimes(1);

    const second = await gate.redeem({ payload: goodPayload('t:1'), expectedResource: 't:1', now: NOW });
    expect(second).toMatchObject({ released: false, code: 'replay' });
    expect(f.settle).toHaveBeenCalledTimes(1); // pořád jednou, ne dvakrát
  });

  it('po selhání settlementu jde legitimní retry znovu', async () => {
    // Kdyby se nonce neuvolnil, zákazník by po výpadku přišel o pokus, aniž
    // by cokoli dostal.
    const store = createMemoryReplayStore(() => NOW);
    const failing = facilitator({ settle: vi.fn().mockRejectedValue(new Error('timeout')) });
    const gate1 = createX402Gate(config(), failing, { replayStore: store });
    await gate1.redeem({ payload: goodPayload('t:1'), expectedResource: 't:1', now: NOW });

    const gate2 = createX402Gate(config(), facilitator(), { replayStore: store });
    const retry = await gate2.redeem({ payload: goodPayload('t:1'), expectedResource: 't:1', now: NOW });
    expect(retry.released).toBe(true);
  });
});

describe('brána — nabídka a odchylka od konvence', () => {
  it('nabídka odpovídá konfiguraci a schématu exact', () => {
    const gate = createX402Gate(config(), facilitator());
    const { requirements, resource } = gate.offer('t:1');
    expect(requirements).toMatchObject({
      scheme: 'exact', network: NETWORK, asset: ASSET, payTo: PAY_TO, amount: '5000',
    });
    // `resource` musí být ResourceInfo s URL, ne řetězec — klient ho vrací
    // beze změny zpátky a naše kontrola se váže právě na `url`.
    expect(resource).toMatchObject({ url: resourceUrl('t:1') });
    expect(typeof resource).toBe('object');
  });

  it('s vypnutým settle-before-release vrací settlement null, ne vymyšlený úspěch', async () => {
    // Falešná odpověď se `success: true` a prázdným hashem by v telemetrii
    // vypadala jako platba, která se nikdy nestala.
    const gate = createX402Gate(config({ X402_SETTLE_BEFORE_RELEASE: 'false' }), facilitator());
    const result = await gate.redeem({ payload: goodPayload('t:1'), expectedResource: 't:1', now: NOW });
    expect(result.released).toBe(true);
    if (result.released) expect(result.settlement).toBeNull();
  });

  it('poškozený payload neprojde a facilitátora nezavolá', async () => {
    const f = facilitator();
    const gate = createX402Gate(config(), f);
    for (const bad of [null, {}, { payload: {} }, { payload: { authorization: 'ne' } }]) {
      const result = await gate.redeem({ payload: bad, expectedResource: 't:1', now: NOW });
      expect(result.released).toBe(false);
    }
    expect(f.verify).not.toHaveBeenCalled();
  });
});
