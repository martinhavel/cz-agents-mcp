#!/usr/bin/env node
/**
 * Dual-purpose: library exports for programmatic use AND stdio server when
 * executed directly (npx @czagents/isir).
 */
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { IsirClient } from './client.js';
import { buildIsirServer } from './server.js';

export { IsirClient } from './client.js';
export type { IsirClientOptions } from './client.js';
export { CuzkClient } from './cuzk.js';
export type { CuzkProceeding, CuzkSearchInput, CuzkResult } from './cuzk.js';
export { buildIsirServer } from './server.js';
export type {
  InsolvencyStatus,
  ProceedingDetail,
  RecentProceedings,
} from './types.js';

async function main() {
  const client = new IsirClient();
  const server = buildIsirServer(client);
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error('[cz-agents/isir] MCP server ready on stdio (alpha — SOAP integration pending)');
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
    console.error('[cz-agents/isir] fatal:', err);
    process.exit(1);
  });
}
