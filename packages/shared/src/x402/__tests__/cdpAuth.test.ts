/**
 * `cdpAuth.ts` řeší strukturální díru: `X402_ALLOW_MAINNET=true` bez
 * `createAuthHeaders` = pád při bootu (viz `facilitator.ts` konstruktor).
 * Tenhle test ověřuje dvě věci nezávisle:
 *
 *   1. Testnet (`authMode: 'none'`) je tímhle modulem NEDOTČENÝ — beze změny.
 *   2. JWT, který `createCdpAuthHeaders` vyrobí, je kryptograficky platný —
 *      podepíše se a hned ověří odvozeným veřejným klíčem. Proti skutečnému
 *      CDP facilitátoru to ověřené NENÍ (chybí testovací klíč, viz docstring
 *      v `cdpAuth.ts`), to je jediná mezera, kterou tenhle test nezavírá.
 */
import { createPublicKey, generateKeyPairSync, verify as verifyEd25519 } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { createCdpAuthHeaders, facilitatorAuthHeadersFor } from '../cdpAuth.js';

/** PKCS8 DER prefix pro Ed25519 (RFC 8410) — stejný jako v cdpAuth.ts. */
const PKCS8_PREFIX = Buffer.from('302e020100300506032b657004220420', 'hex');
/** SPKI DER prefix pro Ed25519 veřejný klíč. */
const SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');

/** Vyrobí platný `CDP_API_KEY_SECRET` (base64, 32 seed + 32 pubkey) ze skutečného Ed25519 klíče. */
function makeApiKeySecret(): { secret: string; publicKeyDer: Buffer } {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const privDer = privateKey.export({ format: 'der', type: 'pkcs8' });
  const pubDer = publicKey.export({ format: 'der', type: 'spki' });
  const seed = privDer.subarray(PKCS8_PREFIX.length);
  const rawPub = pubDer.subarray(SPKI_PREFIX.length);
  expect(seed).toHaveLength(32);
  expect(rawPub).toHaveLength(32);
  return { secret: Buffer.concat([seed, rawPub]).toString('base64'), publicKeyDer: pubDer };
}

describe('facilitatorAuthHeadersFor — testnet (authMode "none") beze změny', () => {
  it('vrací undefined bez ohledu na CDP proměnné v prostředí', () => {
    const env = { CDP_API_KEY_ID: 'unused', CDP_API_KEY_SECRET: 'unused' } as NodeJS.ProcessEnv;
    expect(facilitatorAuthHeadersFor('none', env)).toBeUndefined();
  });

  it('vrací undefined i s úplně prázdným prostředím', () => {
    expect(facilitatorAuthHeadersFor('none', {} as NodeJS.ProcessEnv)).toBeUndefined();
  });
});

describe('facilitatorAuthHeadersFor — mainnet (authMode "cdp")', () => {
  it('bez CDP_API_KEY_ID selže se jménem proměnné', () => {
    const env = { CDP_API_KEY_SECRET: 'x' } as NodeJS.ProcessEnv;
    expect(() => facilitatorAuthHeadersFor('cdp', env)).toThrow(/CDP_API_KEY_ID/);
  });

  it('bez CDP_API_KEY_SECRET selže se jménem proměnné', () => {
    const env = { CDP_API_KEY_ID: 'x' } as NodeJS.ProcessEnv;
    expect(() => facilitatorAuthHeadersFor('cdp', env)).toThrow(/CDP_API_KEY_SECRET/);
  });

  it('se špatnou délkou CDP_API_KEY_SECRET selže s počtem bajtů', () => {
    const env = {
      CDP_API_KEY_ID: 'key-id',
      CDP_API_KEY_SECRET: Buffer.from('too short').toString('base64'),
    } as NodeJS.ProcessEnv;
    expect(() => facilitatorAuthHeadersFor('cdp', env)).toThrow(/64 bajtů/);
  });

  it('s platnými proměnnými vrátí hook, který mainnet boot přestane blokovat', () => {
    const { secret } = makeApiKeySecret();
    const env = { CDP_API_KEY_ID: 'key-id', CDP_API_KEY_SECRET: secret } as NodeJS.ProcessEnv;
    // Tohle je přesně ta strukturální díra ze zadání: dřív žádný volající
    // createAuthHeaders nepředával, takže HttpFacilitator s authMode 'cdp'
    // nešlo vůbec zkonstruovat. Teď existuje hook.
    expect(facilitatorAuthHeadersFor('cdp', env)).toBeTypeOf('function');
  });
});

describe('createCdpAuthHeaders — JWT je kryptograficky platný', () => {
  it('podepíše se soukromým klíčem a ověří odvozeným veřejným', () => {
    const { secret, publicKeyDer } = makeApiKeySecret();
    const createHeaders = createCdpAuthHeaders({ apiKeyId: 'key-id', apiKeySecret: secret });

    const headers = createHeaders({ method: 'POST', url: 'https://api.cdp.coinbase.com/platform/v2/x402/verify' });
    const auth = headers.Authorization;
    expect(auth).toMatch(/^Bearer /);
    const jwt = auth!.slice('Bearer '.length);
    const [headerB64, payloadB64, sigB64] = jwt.split('.');
    expect(headerB64 && payloadB64 && sigB64).toBeTruthy();

    const b64urlToBuf = (s: string) => Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
    const header = JSON.parse(b64urlToBuf(headerB64!).toString('utf8'));
    const payload = JSON.parse(b64urlToBuf(payloadB64!).toString('utf8'));
    const signature = b64urlToBuf(sigB64!);

    expect(header).toMatchObject({ alg: 'EdDSA', typ: 'JWT', kid: 'key-id' });
    expect(payload).toMatchObject({ sub: 'key-id', iss: 'cdp', uri: 'POST api.cdp.coinbase.com/platform/v2/x402/verify' });
    expect(payload.exp - payload.nbf).toBe(120);

    const publicKey = createPublicKey({ key: publicKeyDer, format: 'der', type: 'spki' });
    const signingInput = Buffer.from(`${headerB64}.${payloadB64}`);
    expect(verifyEd25519(null, signingInput, publicKey, signature)).toBe(true);
  });

  it('generuje jiný nonce (a tedy jinou hlavičku) při každém volání', () => {
    const { secret } = makeApiKeySecret();
    const createHeaders = createCdpAuthHeaders({ apiKeyId: 'key-id', apiKeySecret: secret });
    const a = createHeaders({ method: 'GET', url: 'https://api.cdp.coinbase.com/platform/v2/x402/supported' });
    const b = createHeaders({ method: 'GET', url: 'https://api.cdp.coinbase.com/platform/v2/x402/supported' });
    // Nonce mění hlavičku (base64url první segment JWT), i když je request identický.
    expect(a.Authorization).not.toBe(b.Authorization);
  });

  it('podepsané volání se špatným veřejným klíčem neprojde ověřením', () => {
    const { secret } = makeApiKeySecret();
    const { publicKeyDer: wrongPub } = makeApiKeySecret();
    const createHeaders = createCdpAuthHeaders({ apiKeyId: 'key-id', apiKeySecret: secret });
    const jwt = createHeaders({ method: 'POST', url: 'https://api.cdp.coinbase.com/x' }).Authorization!.slice('Bearer '.length);
    const [headerB64, payloadB64, sigB64] = jwt.split('.');
    const b64urlToBuf = (s: string) => Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
    const wrongKey = createPublicKey({ key: wrongPub, format: 'der', type: 'spki' });
    expect(verifyEd25519(null, Buffer.from(`${headerB64}.${payloadB64}`), wrongKey, b64urlToBuf(sigB64!))).toBe(false);
  });
});
