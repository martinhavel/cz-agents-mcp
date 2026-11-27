import type { ServerResponse } from 'node:http';
import type { TokenRecord } from './types.js';

export const OAUTH_RESOURCE_METADATA_URL =
  process.env.OAUTH_RESOURCE_METADATA_URL ?? 'https://dd.cz-agents.dev/.well-known/oauth-protected-resource/mcp';

const PAID_TIERS = ['pro', 'agency', 're_pro', 're_agency'];
export const isPaidTier = (r: Pick<TokenRecord, 'tier'>): boolean => PAID_TIERS.includes(r.tier);

/**
 * Expired token. Paid OAuth tokens (30-day, no refresh) → 401 invalid_token so MCP clients
 * re-authorize; trial/starter → 402 trial_expired upgrade prompt.
 */
export function writeTokenExpired(res: ServerResponse, record: Pick<TokenRecord, 'tier'>, message?: string): void {
  if (isPaidTier(record)) {
    res.writeHead(401, {
      'Content-Type': 'application/json',
      'WWW-Authenticate':
        `Bearer error="invalid_token", error_description="token expired", resource_metadata="${OAUTH_RESOURCE_METADATA_URL}"`,
    });
    res.end(JSON.stringify({ error: 'invalid_token', message: 'Token expired. Re-authorize the connector.' }));
    return;
  }
  res.writeHead(402, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: 'trial_expired', message: message ?? 'Your trial has expired. Upgrade at https://cz-agents.dev/pricing.html' }));
}
