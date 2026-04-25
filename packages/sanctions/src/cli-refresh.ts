#!/usr/bin/env node
/**
 * CLI entry: `npx @czagents/sanctions-refresh` (or via package bin).
 * Refreshes the local DB from all configured sources.
 *
 * Env:
 *   SANCTIONS_DB        — DB path (default ./sanctions.db)
 *   SANCTIONS_EU_URL    — EU FSF XML URL (token-bound)
 *   SANCTIONS_OFAC_URL  — override OFAC SDN.XML URL (default = public)
 */
import { SanctionsDb } from './db.js';
import { refreshAll } from './refresh.js';

async function main() {
  const dbPath = process.env.SANCTIONS_DB ?? './sanctions.db';
  const db = new SanctionsDb(dbPath);
  const summaries = await refreshAll(db);

  for (const s of summaries) {
    if (s.ok) {
      console.log(
        `[${s.source}] ok — fetched=${s.fetched} added=${s.added} modified=${s.modified} removed=${s.removed}`,
      );
    } else {
      console.error(`[${s.source}] FAIL — ${s.error ?? 'unknown error'}`);
    }
  }

  const failed = summaries.filter((s) => !s.ok);
  db.close();
  if (failed.length > 0 && failed.length === summaries.length) {
    process.exit(1);
  }
}

main().catch((err) => {
  console.error('[cz-agents/sanctions-refresh] fatal:', err);
  process.exit(1);
});
