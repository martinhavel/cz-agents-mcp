#!/usr/bin/env node
/**
 * Dual-purpose: library exports for programmatic use AND stdio server when
 * executed directly (npx @czagents/ares / Claude Desktop / Cursor).
 */
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { realpathSync } from 'node:fs';
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
    console.error('[cz-agents/ares] fatal:', err);
    process.exit(1);
  });
}
