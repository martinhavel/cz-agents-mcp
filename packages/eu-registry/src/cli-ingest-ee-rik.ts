#!/usr/bin/env node
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { runEeRikIngest } from './ingest-ee-rik.js';

async function main() {
  const result = await runEeRikIngest();
  console.error(`[cz-agents/eu-registry] EE RIK ingest complete: ${result.imported} companies -> ${result.dbPath}`);
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
    console.error('[cz-agents/eu-registry] EE RIK ingest fatal:', err);
    process.exit(1);
  });
}
