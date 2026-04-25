#!/usr/bin/env node
/**
 * stdio entry. Wires real ARES + sanctions clients on startup.
 *
 * Env:
 *   SANCTIONS_DB — path to sanctions SQLite (optional; without it, sanctions
 *                  screening is silently skipped and only ARES facts populate
 *                  the report).
 */
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { AresClient } from '@czagents/ares';
import { SanctionsDb, SanctionsSearch } from '@czagents/sanctions';
import { buildDdServer } from './server.js';
import type { DdClients } from './clients.js';

async function main() {
  const ares = new AresClient();

  let sanctions: SanctionsSearch | undefined;
  if (process.env.SANCTIONS_DB) {
    const db = new SanctionsDb(process.env.SANCTIONS_DB);
    sanctions = new SanctionsSearch(db);
  }

  const clients: DdClients = { ares, sanctions };
  const server = buildDdServer(clients);
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error(
    `[cz-agents/dd] MCP server ready on stdio (sanctions=${sanctions ? 'enabled' : 'disabled'})`,
  );
}

main().catch((err) => {
  console.error('[cz-agents/dd] fatal:', err);
  process.exit(1);
});
