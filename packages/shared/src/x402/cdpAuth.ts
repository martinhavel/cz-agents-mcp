/**
 * CDP (Coinbase Developer Platform) JWT auth pro x402 facilitátora na mainnetu.
 *
 * `HttpFacilitator` s `authMode: 'cdp'` bez `createAuthHeaders` vůbec nejde
 * zkonstruovat (`facilitator.ts` to hlídá výjimkou) — a dřív to žádný volající
 * nepředával, takže `X402_ALLOW_MAINNET=true` strukturálně nemohlo nastartovat.
 * Tenhle modul tu díru zavírá.
 *
 * Formát JWT je ověřený proti aktuální dokumentaci CDP
 * (docs.cdp.coinbase.com/api-reference/v2/authentication, čteno 27. 7. 2026),
 * NE z paměti modelu — přesná podoba CDP auth je za jeho trénovacím cutoffem
 * a nikde jinde v repu se dosud neimplementovala.
 *
 * Ed25519 (`alg: EdDSA`), ne starší EC P-256 — to je dnešní formát „Secret API
 * Key" vydávaný z CDP portálu (`CDP_API_KEY_SECRET` = base64, 64 bajtů: 32
 * bajtů seed + 32 bajtů veřejný klíč). Token nese `uri` claim vázaný na
 * KONKRÉTNÍ request ("METHOD host/path") a platí jen 120 s, takže se negeneruje
 * jednou při startu, ale znovu pro každé volání facilitátora.
 *
 * ⚠️ Nebylo ověřeno naostro proti CDP facilitátoru (chybí testovací klíč) —
 * jen kryptograficky samo proti sobě (viz `__tests__/cdpAuth.test.ts`: JWT se
 * podepíše a hned ověří odvozeným veřejným klíčem). Před prvním mainnet
 * requestem to prověřit proti skutečnému `/supported`.
 */
import { createPrivateKey, randomBytes, sign as signEd25519, type KeyObject } from 'node:crypto';
import type { FacilitatorAuth } from './config.js';

export interface CdpAuthConfig {
  /** `CDP_API_KEY_ID` — UUID z CDP portálu. */
  apiKeyId: string;
  /** `CDP_API_KEY_SECRET` — base64, 64 bajtů (32 seed + 32 veřejný klíč Ed25519). */
  apiKeySecret: string;
}

export type CreateAuthHeaders = (context: { method: string; url: string }) => Record<string, string>;

/** PKCS8 DER prefix pro Ed25519 soukromý klíč (RFC 8410) — před 32bajtovým seedem. */
const ED25519_PKCS8_PREFIX = Buffer.from('302e020100300506032b657004220420', 'hex');

function toEd25519PrivateKey(apiKeySecret: string): KeyObject {
  const raw = Buffer.from(apiKeySecret, 'base64');
  if (raw.length !== 64) {
    throw new Error(`CDP_API_KEY_SECRET: očekávám 64 bajtů po base64 dekódování (32 seed + 32 pubkey), mám ${raw.length}`);
  }
  const seed = raw.subarray(0, 32);
  const der = Buffer.concat([ED25519_PKCS8_PREFIX, seed]);
  return createPrivateKey({ key: der, format: 'der', type: 'pkcs8' });
}

function base64url(input: Buffer): string {
  return input.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/**
 * @returns `createAuthHeaders` hook pro `HttpFacilitator` — nový JWT pro každé
 *   volání, podepsaný soukromým klíčem odvozeným jednou při konstrukci.
 */
export function createCdpAuthHeaders(config: CdpAuthConfig): CreateAuthHeaders {
  const key = toEd25519PrivateKey(config.apiKeySecret);

  return ({ method, url }) => {
    const parsed = new URL(url);
    const nowSec = Math.floor(Date.now() / 1000);
    const header = { alg: 'EdDSA', typ: 'JWT', kid: config.apiKeyId, nonce: randomBytes(8).toString('hex') };
    const payload = {
      sub: config.apiKeyId,
      iss: 'cdp',
      aud: ['cdp_service'],
      nbf: nowSec,
      exp: nowSec + 120,
      uri: `${method} ${parsed.host}${parsed.pathname}`,
    };
    const signingInput = `${base64url(Buffer.from(JSON.stringify(header)))}.${base64url(Buffer.from(JSON.stringify(payload)))}`;
    const signature = signEd25519(null, Buffer.from(signingInput), key);
    return { Authorization: `Bearer ${signingInput}.${base64url(signature)}` };
  };
}

/**
 * Přečte `CDP_API_KEY_ID`/`CDP_API_KEY_SECRET` z prostředí a vrátí hook pro
 * `HttpFacilitator`, nebo `undefined`, když auth mód není `cdp` (testnet, dnešní
 * stav). Přihlašovací údaje se čtou VÝHRADNĚ z proměnných prostředí — žádný
 * klíč ani adresa nesmí být v kódu ani v testech.
 *
 * @throws Když je `facilitatorAuth === 'cdp'` a proměnné chybí — stejný
 *   fail-loud styl jako `config.ts`: boot padá se jménem proměnné, ne tichým
 *   startem bez auth.
 */
export function facilitatorAuthHeadersFor(
  facilitatorAuth: FacilitatorAuth,
  env: NodeJS.ProcessEnv = process.env,
): CreateAuthHeaders | undefined {
  if (facilitatorAuth !== 'cdp') return undefined;
  const apiKeyId = env.CDP_API_KEY_ID?.trim();
  const apiKeySecret = env.CDP_API_KEY_SECRET?.trim();
  if (!apiKeyId) throw new Error('x402: CDP_API_KEY_ID chybí (X402_FACILITATOR_AUTH=cdp ho vyžaduje)');
  if (!apiKeySecret) throw new Error('x402: CDP_API_KEY_SECRET chybí (X402_FACILITATOR_AUTH=cdp ho vyžaduje)');
  return createCdpAuthHeaders({ apiKeyId, apiKeySecret });
}
