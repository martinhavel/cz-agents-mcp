#!/usr/bin/env node
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { buildEuRegistryServer } from './server.js';

export { UkCompaniesHouseAdapter } from './adapters/uk-companies-house.js';
export { EeRikAdapter } from './adapters/ee-rik.js';
export { LtJarAdapter } from './adapters/lt-jar.js';
export { buildEuRegistryServer } from './server.js';
export { runEeRikIngest, EE_RIK_DATASET_URL, EE_RIK_MIN_RECORDS } from './ingest-ee-rik.js';
export { runLtJarIngest, LT_JAR_DATASET_URL, LT_JAR_PAGE_SIZE } from './ingest-lt-jar.js';
export type { Company, CompanySearchResult, CompanyStatus, RegistryAdapter } from './types.js';

async function main() {
  const server = buildEuRegistryServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error('[cz-agents/eu-registry] MCP server ready on stdio');
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
    console.error('[cz-agents/eu-registry] fatal:', err);
    process.exit(1);
  });
}
