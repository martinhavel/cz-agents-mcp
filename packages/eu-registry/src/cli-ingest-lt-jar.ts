#!/usr/bin/env node
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { runLtJarIngest } from './ingest-lt-jar.js';

async function main() {
  const result = await runLtJarIngest();
  console.error(`[cz-agents/eu-registry] LT JAR ingest complete: ${result.imported} companies -> ${result.dbPath}`);
}
// realpath both sides: under npx / global install argv[1] is the bin symlink.
const isDirectRun = (() => {
  try {
    return realpathSync(process.argv[1] ?? '') === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
})();
if (isDirectRun) main().catch((err) => { console.error('[cz-agents/eu-registry] LT JAR ingest fatal:', err); process.exit(1); });
