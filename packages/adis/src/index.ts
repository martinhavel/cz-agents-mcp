#!/usr/bin/env node
/**
 * Dual-purpose: library exports for programmatic use AND stdio server when
 * executed directly (npx @czagents/adis).
 *
 * Set ADIS_SOAP_ENABLED=1 to actually hit the network. Default is offline
 * stub matching the @czagents/isir convention.
 */
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { AdisClient } from './client.js';
import { buildAdisServer } from './server.js';

export { AdisClient, MAX_DIC_PER_REQUEST, icoToDic, AdisNotConfiguredError, AdisServiceDegradedError } from './client.js';
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
    console.error('[cz-agents/adis] fatal:', err);
    process.exit(1);
  });
}
