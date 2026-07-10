#!/usr/bin/env node
import { fileURLToPath } from 'node:url';
import { runEeRikIngest } from './ingest-ee-rik.js';

async function main() {
  const result = await runEeRikIngest();
  console.error(`[cz-agents/eu-registry] EE RIK ingest complete: ${result.imported} companies -> ${result.dbPath}`);
}

const isDirectRun =
  process.argv[1] !== undefined &&
  fileURLToPath(import.meta.url) === process.argv[1];

if (isDirectRun) {
  main().catch((err) => {
    console.error('[cz-agents/eu-registry] EE RIK ingest fatal:', err);
    process.exit(1);
  });
}
