#!/usr/bin/env node
/**
 * Dual-purpose: library exports for programmatic use AND stdio server when
 * executed directly (npx @czagents/adis).
 *
 * Set ADIS_SOAP_ENABLED=1 to actually hit the network. Default is offline
 * stub matching the @czagents/isir convention.
 */
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { fileURLToPath } from 'node:url';
import { AdisClient } from './client.js';
import { buildAdisServer } from './server.js';

export { AdisClient, MAX_DIC_PER_REQUEST, icoToDic } from './client.js';
export type { AdisClientOptions } from './client.js';
export { buildAdisServer } from './server.js';
export type {
  AdisServiceStatus,
  BulkPayerCheckResult,
  DphPayerStatus,
  DphReliability,
  DphSubjectAddress,
  DphSubjectType,
  PublishedAccount,
  UnreliableListResult,
} from './types.js';

async function main() {
  const client = new AdisClient();
  const server = buildAdisServer(client);
  const transport = new StdioServerTransport();
  await server.connect(transport);
  const mode = process.env.ADIS_SOAP_ENABLED ? 'live SOAP' : 'stub (set ADIS_SOAP_ENABLED=1 to enable)';
  console.error(`[cz-agents/adis] MCP server ready on stdio — ${mode}`);
}

const isDirectRun =
  process.argv[1] !== undefined &&
  fileURLToPath(import.meta.url) === process.argv[1];

if (isDirectRun) {
  main().catch((err) => {
    console.error('[cz-agents/adis] fatal:', err);
    process.exit(1);
  });
}
