import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { trackIco, logToolCall, wrapServerTools } from '@czagents/shared';
import { SanctionsDb, type DbStats } from './db.js';
import { SanctionsSearch } from './search.js';

/** Window beyond which a sanctions list is considered stale (no clean verdict). */
export const SANCTIONS_STALE_THRESHOLD_MS = 48 * 60 * 60 * 1000;

/**
 * Returns a degraded-state warning when the sanctions DB is empty, stale, or
 * has no refresh record — i.e. when a "no match" result must NOT be reported
 * as a confirmed clean screen. Returns null when the DB is healthy/fresh.
 * Pure + exported for testability.
 */
export function sanctionsDbHealthWarning(stats: DbStats, now: number = Date.now()): string | null {
  if (stats.total_active === 0) {
    return '⚠️ Sankční seznam NENÍ načten (0 záznamů) — dotaz neproběhl proti živým datům. ' +
      'Toto NENÍ výsledek „bez sankcí"; NELZE potvrdit čisto. Načti seznamy (EU/OFAC) a opakuj.';
  }
  const refreshedAt = stats.refresh_log
    .filter((l) => l.ok)
    .map((l) => Date.parse(l.refreshed_at))
    .filter((t) => !Number.isNaN(t));
  if (refreshedAt.length === 0) {
    return '⚠️ Sankční seznam: chybí záznam o aktualizaci — stáří dat nelze ověřit, NELZE potvrdit čisto.';
  }
  const newest = Math.max(...refreshedAt);
  if (now - newest > SANCTIONS_STALE_THRESHOLD_MS) {
    const ageH = Math.floor((now - newest) / (60 * 60 * 1000));
    return `⚠️ Sankční seznam je zastaralý (poslední aktualizace před ${ageH} h, práh 48 h) — ` +
      'výsledek „bez sankcí" NELZE považovat za potvrzené čisto. Obnov seznamy a opakuj.';
  }
  return null;
}

export interface ServerDeps {
  db: SanctionsDb;
  search: SanctionsSearch;
}

/**
 * Build an MCP server exposing sanctions screening tools.
 * Pass an open SanctionsDb + SanctionsSearch — caller owns lifecycle.
 */
export function buildSanctionsServer(deps: ServerDeps): McpServer {
  const server = new McpServer(
    {
      name: 'cz-agents/sanctions',
      version: '0.1.0',
    },
    {
      capabilities: { tools: {} },
      instructions:
        'Sanctions / KYC screening across EU consolidated list and OFAC SDN. ' +
        'Use these tools whenever the user asks about screening a person, company, or IČO ' +
        'against sanctions, AML, or compliance lists. ' +
        'Part of the cz-agents MCP suite — companion servers:\n' +
        '• ares.cz-agents.dev/mcp — Czech Business Register (IČO lookup, VAT, bank accounts)\n' +
        '• dd.cz-agents.dev/mcp — full due diligence (ownership, risk score, statutory chain)\n' +
        '• isir.cz-agents.dev/mcp — Czech insolvency register\n' +
        'Free tier rate-limited; higher limits and commercial AML use at https://cz-agents.dev/pricing.html.',
    },
  );
  wrapServerTools(server);

  const { db, search } = deps;

  // A "clean" (no-match) sanctions result is only trustworthy if the underlying
  // list is actually loaded and reasonably fresh. An empty or stale DB must
  // NOT produce a definitive "not sanctioned" verdict — prepend a degraded
  // warning so the caller never reads silence as a clean screen.
  function withCleanGuard(text: string) {
    let warn: string | null;
    try {
      warn = sanctionsDbHealthWarning(db.stats());
    } catch {
      warn = '⚠️ Sankční seznam: stav databáze nelze ověřit — NELZE potvrdit „bez sankcí".';
    }
    if (!warn) return wrap(text);
    return { content: [{ type: 'text' as const, text: `${warn}\n\n${text}` }], isError: true };
  }

  server.tool(
    'search_person',
    'Fuzzy-search a sanctioned person by name across all loaded lists. Optional date of birth and nationality narrow results. Returns matches with confidence scores (0-100). 100 = exact ID match, 80+ = strong fuzzy match, lower = review needed.',
    {
      name: z.string().describe('Full name. Cyrillic / Arabic / Chinese tolerated; transliteration applied.'),
      dob: z.string().describe('YYYY or YYYY-MM-DD. Optional, narrows matches.').optional(),
      nationality: z.string().describe('Country name or ISO code. Optional.').optional(),
      threshold: z.number().int().min(0).max(100).default(80).describe('Min confidence to include in results (default 80).'),
      limit: z.number().int().min(1).max(100).default(20).describe('Max results (default 20).'),
    },
    { title: 'Search Sanctioned Person', readOnlyHint: true, openWorldHint: true },
    async ({ name, dob, nationality, threshold, limit }) => {
      logToolCall('sanctions', 'search_person', { name, dob, nationality, threshold, limit });
      const matches = search.searchByName(name, { dob, nationality, threshold, limit, typeFilter: 'person' });
      return matches.length === 0
        ? withCleanGuard(`Žádný match pro "${name}" (threshold ${threshold}).`)
        : wrap(formatMatches(name, matches));
    },
  );

  server.tool(
    'search_entity',
    'Fuzzy-search a sanctioned entity (company, organization) by name. Optional country narrows results.',
    {
      name: z.string().describe('Company / organization name.'),
      country: z.string().describe('Country filter (name or ISO code).').optional(),
      threshold: z.number().int().min(0).max(100).default(80).describe('Min confidence (default 80).'),
      limit: z.number().int().min(1).max(100).default(20).describe('Max results (default 20).'),
    },
    { title: 'Search Sanctioned Entity', readOnlyHint: true, openWorldHint: true },
    async ({ name, country, threshold, limit }) => {
      logToolCall('sanctions', 'search_entity', { name, country, threshold, limit });
      const matches = search.searchByName(name, { nationality: country, threshold, limit, typeFilter: 'entity' });
      return matches.length === 0
        ? withCleanGuard(`Žádný match pro "${name}" (threshold ${threshold}).`)
        : wrap(formatMatches(name, matches));
    },
  );

  server.tool(
    'check_ico',
    'Check whether a Czech IČO (or any company by IČO) appears on sanctions lists. Direct exact-ID lookup; pass `name` to also fuzzy-match if no direct hit.',
    {
      ico: z.string().describe('Czech IČO (7-8 digits) or comparable national company ID.'),
      name: z.string().describe('Optional company name for fuzzy fallback if IČO not directly listed.').optional(),
    },
    { title: 'Check IČO Against Sanctions', readOnlyHint: true, openWorldHint: true },
    async ({ ico, name }) => {
      logToolCall('sanctions', 'check_ico', { ico, name });
      trackIco(ico);
      const matches = search.searchByIco(ico, name);
      return matches.length === 0
        ? withCleanGuard(`IČO ${ico} se nevyskytuje na sankčních seznamech (EU+OFAC).`)
        : wrap(formatMatches(`IČO ${ico}`, matches));
    },
  );

  server.tool(
    'get_listing',
    'Retrieve the full record for a single sanctions listing by its ID (format: `${source}:${source_list_id}`, e.g. "ofac:12345" or "eu:EU.123.789").',
    {
      id: z.string().describe('Internal listing ID, e.g. "ofac:12345".'),
    },
    { title: 'Get Sanctions Listing Detail', readOnlyHint: true, openWorldHint: true },
    async ({ id }) => {
      logToolCall('sanctions', 'get_listing', { id });
      const entity = db.getById(id);
      if (!entity) return wrap(`Listing ${id} nenalezen.`);
      return wrap(JSON.stringify(entity, null, 2));
    },
  );

  server.tool(
    'list_recent_updates',
    'List sanctions added/removed/modified since a given date. Use for daily monitoring against a watchlist.',
    {
      since: z.string().describe('ISO date or datetime, e.g. "2026-04-01" or "2026-04-01T00:00:00Z".'),
      source: z.enum(['eu', 'ofac', 'un', 'ofsi', 'fau']).optional().describe('Optional source filter.'),
    },
    { title: 'List Recent Sanctions Updates', readOnlyHint: true, openWorldHint: true },
    async ({ since, source }) => {
      logToolCall('sanctions', 'list_recent_updates', { since, source });
      const sinceMs = new Date(since).getTime();
      if (Number.isNaN(sinceMs)) {
        return { content: [{ type: 'text', text: `Invalid date: ${since}` }], isError: true };
      }
      const changes = db.changesSince(sinceMs, source);
      return wrap(JSON.stringify({
        since,
        until: new Date().toISOString(),
        added: changes.added.length,
        removed: changes.removed.length,
        modified: changes.modified.length,
        details: changes,
      }, null, 2));
    },
  );

  return server;
}

function wrap(text: string) {
  return { content: [{ type: 'text' as const, text }] };
}

function formatMatches(query: string, matches: Array<{ entity: { id: string; primary_name: string; type: string; programs: string[]; source: string }; confidence: number; matched_on: string; matched_alias?: string }>): string {
  const lines = [`Match pro "${query}" — ${matches.length} hit(s):`, ''];
  for (const m of matches) {
    const aliasNote = m.matched_alias ? ` via alias "${m.matched_alias}"` : '';
    lines.push(
      `▸ [${m.confidence}%] ${m.entity.primary_name} (${m.entity.type})`,
      `   id: ${m.entity.id}`,
      `   programs: ${m.entity.programs.join(', ') || '-'}`,
      `   matched_on: ${m.matched_on}${aliasNote}`,
      '',
    );
  }
  return lines.join('\n');
}
