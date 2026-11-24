import { createHash, createHmac, randomUUID } from 'node:crypto';

export interface TokenProtection {
  token_id: string;
  token_hmac: string;
  hmac_key_id: string;
  token_prefix: string;
  tenant_key: string | null;
}

/** F1 is opt-in until OPS installs the same key configuration in every writer. */
export function tokenProtectionEnabled(): boolean {
  const flag = process.env.CZ_AGENTS_TOKEN_F1;
  if (flag !== undefined && flag !== '0' && flag !== '1') throw new Error('TOKEN_F1_CONFIGURATION');
  return flag === '1';
}

export function protectionKey(name: string): Buffer {
  const value = process.env[name];
  if (!value) throw new Error('TOKEN_PROTECTION_KEY_REQUIRED');
  const key = Buffer.from(value, 'base64');
  if (key.length !== 32 || key.toString('base64') !== value) throw new Error('TOKEN_PROTECTION_KEY_INVALID');
  return key;
}

export function protectionKeyId(name: string): string {
  const value = process.env[name];
  if (!value || !/^[A-Za-z0-9._-]{1,64}$/.test(value)) throw new Error('TOKEN_PROTECTION_KEY_ID_REQUIRED');
  return value;
}

export function protectToken(token: string, service: string, tokenId: string = randomUUID()): TokenProtection {
  if (!token || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(tokenId)) {
    throw new Error('TOKEN_PROTECTION_INPUT');
  }
  const key = protectionKey('CZ_AGENTS_TOKEN_HMAC_PEPPER');
  const keyId = protectionKeyId('CZ_AGENTS_TOKEN_HMAC_KEY_ID');
  return {
    token_id: tokenId,
    token_hmac: createHmac('sha256', key).update('cz-agents-api-token:v1\0').update(token, 'utf8').digest('hex'),
    hmac_key_id: keyId,
    token_prefix: /^czat_[A-Za-z0-9_-]{43}$/.test(token) ? token.slice(0, 12) : '',
    // Keep existing DD+ watchlist bindings; this is not the verifier digest.
    tenant_key: service === 'ddplus' ? createHash('sha256').update(token, 'utf8').digest('hex') : null,
  };
}
