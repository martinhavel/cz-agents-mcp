#!/usr/bin/env node
import { fileURLToPath } from 'node:url';
import { runLtJarIngest } from './ingest-lt-jar.js';

async function main() {
  const result = await runLtJarIngest();
  console.error(`[cz-agents/eu-registry] LT JAR ingest complete: ${result.imported} companies -> ${result.dbPath}`);
}
const isDirectRun = process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1];
if (isDirectRun) main().catch((err) => { console.error('[cz-agents/eu-registry] LT JAR ingest fatal:', err); process.exit(1); });
