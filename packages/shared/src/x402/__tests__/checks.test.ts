import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  checkAmount, checkAsset, checkExpiry, checkNetwork, checkPayTo, checkReplay,
  checkResourceBinding, createMemoryReplayStore, resourceId, runAllChecks,
  type Authorization,
} from '../checks.js';

const NOW = 1_800_000_000_000; // pevný čas, ať testy nezávisí na hodinách
const nowSec = Math.floor(NOW / 1000);
const PAY_TO = '0x1111111111111111111111111111111111111111';
const ASSET = '0x036CbD53842c5426634e7929541eC2318f3dCF7e';
const NETWORK = 'eip155:84532';
const sha = (s: string): string => createHash('sha256').update(s).digest('hex').slice(0, 16);

const auth = (over: Partial<Authorization> = {}): Authorization => ({
  from: '0x2222222222222222222222222222222222222222',
  to: PAY_TO,
  value: '5000',
  validAfter: String(nowSec - 60),
  validBefore: String(nowSec + 300),
  nonce: '0x' + 'ab'.repeat(32),
  ...over,
});

describe('1. expirace — nestačí, že platí; musí platit dost dlouho', () => {
  it('projde, když zbývá víc než potřebuje settlement', () => {
    expect(checkExpiry(auth(), 60, NOW).ok).toBe(true);
  });

  it('odmítne autorizaci, která už vypršela', () => {
    expect(checkExpiry(auth({ validBefore: String(nowSec - 1) }), 60, NOW))
      .toMatchObject({ ok: false, code: 'expired' });
  });

  it('odmítne autorizaci, která ještě neplatí', () => {
    expect(checkExpiry(auth({ validAfter: String(nowSec + 60) }), 60, NOW))
      .toMatchObject({ ok: false, code: 'not_yet_valid' });
  });

  it('odmítne okno, které se zavře během settlementu', () => {
    // Platí ještě 30 s, ale settlement potřebuje 60 — vydali bychom data
    // a převod by selhal. Tohle je ten případ, kvůli kterému kontrola existuje.
    expect(checkExpiry(auth({ validBefore: String(nowSec + 30) }), 60, NOW))
      .toMatchObject({ ok: false, code: 'window_too_short' });
  });

  it('odmítne nečitelné hodnoty místo aby je bral jako nulu', () => {
    expect(checkExpiry(auth({ validBefore: 'zítra' }), 60, NOW).ok).toBe(false);
  });
});

describe('2. síť — alias není synonymum', () => {
  it('projde na přesné shodě', () => {
    expect(checkNetwork(NETWORK, NETWORK).ok).toBe(true);
  });

  it('odmítne legacy název, i když míří na tutéž síť', () => {
    expect(checkNetwork('base-sepolia', NETWORK)).toMatchObject({ ok: false, code: 'network_mismatch' });
  });

  it('odmítne mainnet payload na testnetové konfiguraci', () => {
    expect(checkNetwork('eip155:8453', NETWORK).ok).toBe(false);
  });
});

describe('3. aktivum', () => {
  it('velikost písmen nerozhoduje', () => {
    expect(checkAsset(ASSET.toLowerCase(), ASSET.toUpperCase()).ok).toBe(true);
  });

  it('odmítne jiný kontrakt', () => {
    expect(checkAsset('0xd9aAEc86B65D86f6A7B5B1b0c42FFA531710b6CA', ASSET))
      .toMatchObject({ ok: false, code: 'asset_mismatch' });
  });
});

describe('4. příjemce', () => {
  it('projde na naší adrese bez ohledu na checksum', () => {
    expect(checkPayTo(auth({ to: PAY_TO.toLowerCase() }), PAY_TO).ok).toBe(true);
  });

  it('odmítne podobnou, ale jinou adresu', () => {
    const almost = PAY_TO.slice(0, -1) + (PAY_TO.endsWith('5') ? '6' : '5');
    expect(checkPayTo(auth({ to: almost }), PAY_TO)).toMatchObject({ ok: false, code: 'pay_to_mismatch' });
  });
});

describe('5. částka — scheme=exact znamená přesnou rovnost', () => {
  it('projde na přesné částce a vrátí fakta do telemetrie', () => {
    expect(checkAmount(auth({ value: '5000' }), '5000')).toMatchObject({
      ok: true,
      amounts: { requiredAmount: '5000', paidAmount: '5000', overpayment: '0' },
    });
  });

  it('odmítne podplacení', () => {
    expect(checkAmount(auth({ value: '4999' }), '5000')).toMatchObject({
      ok: false, code: 'amount_mismatch',
      amounts: { requiredAmount: '5000', paidAmount: '4999', overpayment: '0' },
    });
  });

  it('ODMÍTNE i přeplatek — u exact je autorita facilitátor a ten ho zamítne', () => {
    // Tolerantnější kontrola před přísnější branou není velkorysost, je to
    // rozpor: přijali bychom platbu, kterou facilitátor odmítne.
    const result = checkAmount(auth({ value: '5001' }), '5000');
    expect(result).toMatchObject({ ok: false, code: 'amount_mismatch' });
    expect(result.detail).toMatch(/exact/);
  });

  it('přeplatek je v telemetrii vidět jako přeplatek, ne jako obecná neshoda', () => {
    expect(checkAmount(auth({ value: '7500' }), '5000').amounts).toEqual({
      requiredAmount: '5000', paidAmount: '7500', overpayment: '2500',
    });
  });

  it('odmítne nečitelnou částku místo aby ji bral jako nulu', () => {
    expect(checkAmount(auth({ value: 'hodně' }), '5000').ok).toBe(false);
  });

  it('zvládne částky mimo rozsah Number bez ztráty přesnosti', () => {
    const huge = '9007199254740993'; // Number.MAX_SAFE_INTEGER + 2
    expect(checkAmount(auth({ value: huge }), huge).ok).toBe(true);
    // Liší se až v poslední číslici — v Number by obě byly stejné.
    expect(checkAmount(auth({ value: '9007199254740992' }), huge).ok).toBe(false);
  });
});

describe('6. resource binding — kontrola, kterou facilitátor udělat nemůže', () => {
  const cheap = resourceId('check_ico', { ico: '27074358' }, sha);
  const expensive = resourceId('rescreen_portfolio', { subjects: ['a', 'b'] }, sha);

  it('projde, když platba patří k tomu, co vydáváme', () => {
    expect(checkResourceBinding(cheap, cheap).ok).toBe(true);
  });

  it('ODMÍTNE platbu vyraženou pro levný nástroj u drahého', () => {
    // Bez téhle kontroly by útočník koupil nejlevnější zdroj a odemkl nejdražší.
    // Facilitátor převod provede — podpis je platný a částka sedí na to, co je
    // v autorizaci. O tom, co se chystáme vydat, neví.
    expect(checkResourceBinding(cheap, expensive)).toMatchObject({ ok: false, code: 'resource_mismatch' });
  });

  it('odmítne payload, který zdroj neuvádí vůbec', () => {
    expect(checkResourceBinding(undefined, cheap).ok).toBe(false);
    expect(checkResourceBinding('', cheap).ok).toBe(false);
    expect(checkResourceBinding({ tool: 'check_ico' }, cheap).ok).toBe(false);
  });

  it('identifikátor je stabilní vůči pořadí klíčů, ale citlivý na hodnoty', () => {
    expect(resourceId('t', { a: 1, b: 2 }, sha)).toBe(resourceId('t', { b: 2, a: 1 }, sha));
    expect(resourceId('t', { a: 1 }, sha)).not.toBe(resourceId('t', { a: 2 }, sha));
    expect(resourceId('t', { a: 1 }, sha)).not.toBe(resourceId('u', { a: 1 }, sha));
  });
});

describe('7. replay — deduplikace našich výdejů, ne kryptografie', () => {
  it('první použití projde, druhé ne', () => {
    const store = createMemoryReplayStore(() => NOW);
    expect(checkReplay(auth(), store, 60).ok).toBe(true);
    expect(checkReplay(auth(), store, 60)).toMatchObject({ ok: false, code: 'replay' });
  });

  it('různé nonce se navzájem neblokují', () => {
    const store = createMemoryReplayStore(() => NOW);
    expect(checkReplay(auth({ nonce: '0x01' }), store, 60).ok).toBe(true);
    expect(checkReplay(auth({ nonce: '0x02' }), store, 60).ok).toBe(true);
  });

  it('po uvolnění jde legitimní retry znovu', () => {
    // Settlement selhal → nonce se uvolní. Blokovat retry po neúspěšné platbě
    // by znamenalo, že zákazník přišel o pokus, aniž by cokoli dostal.
    const store = createMemoryReplayStore(() => NOW);
    checkReplay(auth(), store, 60);
    store.release(auth().nonce);
    expect(checkReplay(auth(), store, 60).ok).toBe(true);
  });

  it('záznam vyprší po TTL', () => {
    let clock = NOW;
    const store = createMemoryReplayStore(() => clock);
    expect(checkReplay(auth(), store, 60).ok).toBe(true);
    clock += 61_000;
    expect(checkReplay(auth(), store, 60).ok).toBe(true);
  });

  it('odmítne autorizaci bez nonce', () => {
    const store = createMemoryReplayStore(() => NOW);
    expect(checkReplay(auth({ nonce: '' }), store, 60).ok).toBe(false);
  });
});

describe('runAllChecks — pořadí a celková brána', () => {
  const base = () => ({
    auth: auth(),
    payloadNetwork: NETWORK,
    payloadAsset: ASSET,
    payloadResource: 'tool:abc',
    expectedResource: 'tool:abc',
    expectedAmount: '5000',
    config: { network: NETWORK, asset: ASSET, payTo: PAY_TO, maxTimeoutSeconds: 60, settleMarginSeconds: 10 },
    replayStore: createMemoryReplayStore(() => NOW),
    now: NOW,
  });

  it('platný payload projde všemi sedmi', () => {
    expect(runAllChecks(base()).ok).toBe(true);
  });

  it('replay NEZABERE místo v cache, když payload selže dřív', () => {
    // Kdyby se replay kontroloval první, útočník by cizím nonce zaplnil cache
    // a zablokoval legitimní platby. Proto je poslední.
    const input = { ...base(), payloadNetwork: 'eip155:8453' };
    expect(runAllChecks(input)).toMatchObject({ ok: false, code: 'network_mismatch' });
    // Tentýž nonce musí pořád projít, protože ho odmítnutý pokus nezabral.
    expect(runAllChecks({ ...base(), replayStore: input.replayStore }).ok).toBe(true);
  });

  for (const [label, patch] of [
    ['špatná síť', { payloadNetwork: 'eip155:8453' }],
    ['špatné aktivum', { payloadAsset: '0x4444444444444444444444444444444444444444' }],
    ['cizí příjemce', { auth: auth({ to: '0x3333333333333333333333333333333333333333' }) }],
    ['podplaceno', { auth: auth({ value: '1' }) }],
    ['jiný zdroj', { payloadResource: 'jiny:zdroj' }],
    ['expirováno', { auth: auth({ validBefore: String(nowSec - 1) }) }],
  ] as const) {
    it(`${label} → data se nevydají`, () => {
      expect(runAllChecks({ ...base(), ...patch }).ok).toBe(false);
    });
  }
});
