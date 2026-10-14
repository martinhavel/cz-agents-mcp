#!/usr/bin/env node
/**
 * stdio entry for @czagents/realestate MCP server.
 *
 * Env:
 *   REALESTATE_DB_PATH   — read-only SQLite path (default /data/webapp.db)
 *
 * For Streamable HTTP transport (= hosted deployment), use ./http.js
 * instead — it adds tier-aware token gating + rate limiting.
 */

import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { buildRealEstateServer } from './server.js';

export { buildRealEstateServer } from './server.js';
export type { RealEstateTier } from './server.js';
export type { DistrictAggregate, MarketTrend } from './types.js';

async function main() {
  const server = buildRealEstateServer('free');
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error('[cz-agents/realestate] MCP server ready on stdio (tier=free)');
}

// realpath both sides: under npx / global install argv[1] is the bin symlink.
const isDirectRun = (() => {
  try {
    return realpathSync(process.argv[1] ?? '') === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
})();

if (isDirectRun) {
  main().catch((err) => {
    console.error('[cz-agents/realestate] fatal:', err);
    process.exit(1);
  });
}
