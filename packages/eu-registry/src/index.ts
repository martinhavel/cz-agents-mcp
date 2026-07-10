#!/usr/bin/env node
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { fileURLToPath } from 'node:url';
import { buildEuRegistryServer } from './server.js';

export { UkCompaniesHouseAdapter } from './adapters/uk-companies-house.js';
export { EeRikAdapter } from './adapters/ee-rik.js';
export { buildEuRegistryServer } from './server.js';
export { runEeRikIngest, EE_RIK_DATASET_URL, EE_RIK_MIN_RECORDS } from './ingest-ee-rik.js';
export type { Company, CompanySearchResult, CompanyStatus, RegistryAdapter } from './types.js';

async function main() {
  const server = buildEuRegistryServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error('[cz-agents/eu-registry] MCP server ready on stdio');
}

const isDirectRun =
  process.argv[1] !== undefined &&
  fileURLToPath(import.meta.url) === process.argv[1];

if (isDirectRun) {
  main().catch((err) => {
    console.error('[cz-agents/eu-registry] fatal:', err);
    process.exit(1);
  });
}
