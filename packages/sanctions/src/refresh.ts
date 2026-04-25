/**
 * Orchestrates fetching all configured sources and upserting into the DB.
 * On any source failure, that source's records remain at last known good
 * state — partial outages don't wipe data.
 */
import { SanctionsDb } from './db.js';
import { SOURCES, type SourceDef } from './fetchers/index.js';

export interface RefreshSummary {
  source: string;
  ok: boolean;
  fetched: number;
  added: number;
  modified: number;
  removed: number;
  error?: string;
}

export async function refreshAll(db: SanctionsDb): Promise<RefreshSummary[]> {
  const summaries: RefreshSummary[] = [];
  for (const def of SOURCES) {
    summaries.push(await refreshSource(db, def));
  }
  return summaries;
}

async function refreshSource(db: SanctionsDb, def: SourceDef): Promise<RefreshSummary> {
  const url = def.url();
  if (!url) {
    return {
      source: def.source,
      ok: false,
      fetched: 0,
      added: 0,
      modified: 0,
      removed: 0,
      error: `No URL configured for ${def.source} (env var missing).`,
    };
  }

  try {
    const xml = await fetchXml(url);
    const entities = def.parse(xml);
    const diff = db.upsertSource(def.source, entities);
    return { source: def.source, ok: true, fetched: entities.length, ...diff };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    db.recordRefreshFailure(def.source, msg);
    return {
      source: def.source,
      ok: false,
      fetched: 0,
      added: 0,
      modified: 0,
      removed: 0,
      error: msg,
    };
  }
}

async function fetchXml(url: string): Promise<string> {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), 60_000);
  try {
    const res = await fetch(url, {
      signal: ac.signal,
      redirect: 'follow',
      headers: {
        Accept: 'application/xml, text/xml',
        'User-Agent': 'cz-agents-sanctions/0.1.0 (+https://cz-agents.dev)',
      },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText} fetching ${url}`);
    return await res.text();
  } finally {
    clearTimeout(t);
  }
}
