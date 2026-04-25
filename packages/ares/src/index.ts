#!/usr/bin/env node
/**
 * Dual-purpose: library exports for programmatic use AND stdio server when
 * executed directly (npx @czagents/ares / Claude Desktop / Cursor).
 */
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { fileURLToPath } from 'node:url';
import { buildAresServer } from './server.js';

export { AresClient } from './client.js';
export type {
  AresSubject,
  AresSearchResult,
  AresBankAccount,
  AresVrRecord,
} from './client.js';
export { buildAresServer } from './server.js';

async function main() {
  const server = buildAresServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error('[cz-agents/ares] MCP server ready on stdio');
}

const isDirectRun =
  process.argv[1] !== undefined &&
  fileURLToPath(import.meta.url) === process.argv[1];

if (isDirectRun) {
  main().catch((err) => {
    console.error('[cz-agents/ares] fatal:', err);
    process.exit(1);
  });
}
