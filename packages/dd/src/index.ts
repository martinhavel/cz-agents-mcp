#!/usr/bin/env node
/**
 * stdio entry. Wires real ARES + sanctions + ISIR clients on startup.
 *
 * Env:
 *   SANCTIONS_DB        — path to sanctions SQLite (optional; without it,
 *                         sanctions screening is skipped, ARES facts only)
 *   ISIR_SOAP_ENABLED   — when set, attempt real ISIR SOAP queries (alpha,
 *                         v0.2.0+); default = stub mode (returns null gracefully)
 */
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { fileURLToPath } from 'node:url';
import { AresClient } from '@czagents/ares';
import { SanctionsDb, SanctionsSearch } from '@czagents/sanctions';
import { IsirClient } from '@czagents/isir';
import { buildDdServer } from './server.js';
import type { DdClients } from './clients.js';

export { buildDdServer } from './server.js';
export type * from './types.js';

async function main() {
  const ares = new AresClient();

  let sanctions: SanctionsSearch | undefined;
  if (process.env.SANCTIONS_DB) {
    const db = new SanctionsDb(process.env.SANCTIONS_DB);
    sanctions = new SanctionsSearch(db);
  }

  const isir = new IsirClient();

  const clients: DdClients = { ares, sanctions, isir };
  const server = buildDdServer(clients);
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error(
    `[cz-agents/dd] MCP server ready on stdio (sanctions=${sanctions ? 'enabled' : 'disabled'}, isir=${process.env.ISIR_SOAP_ENABLED ? 'soap' : 'stub'})`,
  );
}

const isDirectRun =
  process.argv[1] !== undefined &&
  fileURLToPath(import.meta.url) === process.argv[1];

if (isDirectRun) {
  main().catch((err) => {
    console.error('[cz-agents/dd] fatal:', err);
    process.exit(1);
  });
}
export { detectNomineeDirector, INDICATOR_LABELS } from './patterns/nominee-director.js';
export type { IndicatorCode, NomineeIndicator, NomineeReport } from './patterns/nominee-director.js';
export { buildTimeline } from './patterns/risk-timeline.js';
export type { EventSeverity, TimelineEvent } from './patterns/risk-timeline.js';
