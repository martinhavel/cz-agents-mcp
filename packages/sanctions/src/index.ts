#!/usr/bin/env node
/**
 * Dual-purpose: library exports for programmatic use AND stdio server when
 * executed directly (npx @czagents/sanctions / Claude Desktop / Cursor).
 *
 * Env:
 *   SANCTIONS_DB — path to SQLite DB (default ./sanctions.db)
 *
 * To populate / refresh the DB run `cz-agents-sanctions-refresh` first.
 */
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { SanctionsDb } from './db.js';
import { SanctionsSearch } from './search.js';
import { buildSanctionsServer } from './server.js';

export { SanctionsDb } from './db.js';
export { SanctionsSearch, nameSimilarity } from './search.js';
export { buildSanctionsServer } from './server.js';
export { refreshAll } from './refresh.js';
export type {
  SanctionedEntity,
  SanctionSource,
  SanctionedType,
  SanctionAddress,
  SanctionId,
  MatchResult,
  SearchPersonInput,
  SearchEntityInput,
  RecentUpdates,
} from './types.js';

async function main() {
  const dbPath = process.env.SANCTIONS_DB ?? './sanctions.db';
  const db = new SanctionsDb(dbPath);
  const search = new SanctionsSearch(db);
  const server = buildSanctionsServer({ db, search });
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error(`[cz-agents/sanctions] MCP server ready on stdio (db: ${dbPath})`);
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
    console.error('[cz-agents/sanctions] fatal:', err);
    process.exit(1);
  });
}
