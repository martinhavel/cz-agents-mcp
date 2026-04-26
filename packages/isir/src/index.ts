#!/usr/bin/env node
/**
 * Dual-purpose: library exports for programmatic use AND stdio server when
 * executed directly (npx @czagents/isir).
 */
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
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

const isDirectRun =
  process.argv[1] !== undefined &&
  fileURLToPath(import.meta.url) === process.argv[1];

if (isDirectRun) {
  main().catch((err) => {
    console.error('[cz-agents/isir] fatal:', err);
    process.exit(1);
  });
}
