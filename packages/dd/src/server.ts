import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { validateIcoInput, trackIco, logToolCall } from '@czagents/shared';
import { buildReport } from './report.js';
import { buildChain } from './chain.js';
import { detectNomineeDirector } from './patterns/nominee-director.js';
import { buildTimeline } from './patterns/risk-timeline.js';
import { detectPhoenix } from './patterns/phoenix.js';
import { detectAddressCrowding } from './patterns/address-crowding.js';
import { lookupGleifParent, getByLei } from './gleif-lookup.js';
import type { DdClients } from './clients.js';

/**
 * Tier kind — controls which tools are available to the caller.
 *   - 'free'        : get_dd_report (basic), get_risk_score (rate-limited)
 *   - 'compliance'  : + nominee, timeline patterns (Pro Compliance €99/mo)
 *   - 'agency'      : + statutory_chain, bulk_lookup, watchlist (Agency €199/mo)
 *
 * 'enterprise' = treated as 'agency' for tool discovery.
 */
export type DdTier = 'free' | 'compliance' | 'agency' | 'enterprise';

/** Tool gating — returns 403 JSON-RPC error when caller lacks tier. */
function requireTier(currentTier: DdTier, required: DdTier, toolName: string) {
  const order: DdTier[] = ['free', 'compliance', 'agency', 'enterprise'];
  if (order.indexOf(currentTier) >= order.indexOf(required)) return null;
  return {
    content: [
      {
        type: 'text' as const,
        text: JSON.stringify({
          error: 'tier_required',
          tool: toolName,
          tier_needed: required,
          current_tier: currentTier,
          message: `Tool '${toolName}' requires '${required}' tier or higher. Current: '${currentTier}'. Upgrade at https://cz-agents.dev/pricing.html`,
          upgrade_url: 'https://cz-agents.dev/pricing.html?utm_source=mcp&utm_medium=tier_gate',
        }, null, 2),
      },
    ],
    isError: true,
  };
}

export function buildDdServer(clients: DdClients, tier: DdTier = 'free'): McpServer {
  const server = new McpServer(
    {
      name: 'cz-agents/dd',
      version: '0.1.0',
    },
    {
      capabilities: { tools: {} },
      instructions:
        'Czech company due-diligence aggregator. Combines ARES (legal data, statutory body, VAT, bank accounts), ' +
        'sanctions screening, and (optionally) ISIR insolvency check into a single risk-scored report. ' +
        'Use whenever the user asks for KYC / DD / company background check on a Czech IČO. ' +
        'Free tier (basic report) rate-limited; Compliance and Agency tiers (more tools, higher quotas) at https://cz-agents.dev/pricing.html.',
    },
  );

  server.tool(
    'get_dd_report',
    'Generate a complete due-diligence report for a Czech IČO. Returns company facts (name, address, legal form, VAT status, bank accounts), statutory body with per-member sanctions check, and a transparent risk score with all triggered red flags.',
    {
      ico: z.string().describe('Czech IČO — 7 or 8 digits.'),
      depth: z
        .enum(['basic', 'full'])
        .default('basic')
        .describe('basic = ARES + sanctions only; full = + ISIR insolvency + virtual-address probe.'),
    },
    { title: 'Get Czech Company Due-Diligence Report', readOnlyHint: true, openWorldHint: true },
    async ({ ico, depth }) => {
      logToolCall('dd', 'get_dd_report', { ico, depth });
      const clean = validateIcoInput(ico);
      trackIco(clean);
      const report = await buildReport(clean, clients, { depth });
      return wrap(JSON.stringify(report, null, 2));
    },
  );

  server.tool(
    'get_risk_score',
    'Lightweight version of get_dd_report — returns just the numeric score (0-100), risk level, and top triggered red flags. Faster when you only need a yes/no/maybe screen.',
    {
      ico: z.string().describe('Czech IČO — 7 or 8 digits.'),
    },
    { title: 'Get Risk Score', readOnlyHint: true, openWorldHint: true },
    async ({ ico }) => {
      logToolCall('dd', 'get_risk_score', { ico });
      const clean = validateIcoInput(ico);
      trackIco(clean);
      const report = await buildReport(clean, clients, { depth: 'basic' });
      const top = report.red_flags.slice().sort((a, b) => b.weight - a.weight).slice(0, 5);
      return wrap(JSON.stringify({
        ico: clean,
        company_name: report.company.name,
        value: report.risk_score.value,
        level: report.risk_score.level,
        top_flags: top,
      }, null, 2));
    },
  );

  server.tool(
    'get_statutory_chain',
    'Surname-based heuristic walk through statutory bodies of related Czech companies. Best for shell-company unwinding in small s.r.o. with RARE surnames. NOT a true UBO source — for actual beneficial ownership use the ESM (evidence skutečných majitelů, separate registry, future @czagents/esm). For boards of large public companies with common Czech surnames (Novák, Zima, Kolář…) results are noisy by design; the tool auto-skips persons whose surname matches >50 companies with a SURNAME_TOO_COMMON note.',
    {
      ico: z.string().describe('Czech IČO — 7 or 8 digits.'),
      max_depth: z.number().int().min(1).max(5).default(3).describe('Max recursion depth (default 3, hard cap 5).'),
    },
    { title: 'Get Statutory Chain (UBO Walk)', readOnlyHint: true, openWorldHint: true },
    async ({ ico, max_depth }) => {
      logToolCall('dd', 'get_statutory_chain', { ico, max_depth });
      const gate = requireTier(tier, 'agency', 'get_statutory_chain');
      if (gate) return gate;
      const clean = validateIcoInput(ico);
      trackIco(clean);
      const result = await buildChain(clean, clients.ares, { maxDepth: max_depth });
      return wrap(JSON.stringify(result, null, 2));
    },
  );

  // 2026-05-08 — Pro Compliance tier exclusive (= compliance + agency).
  server.tool(
    'detect_nominee_director',
    'Detect "white horse" / nominee director patterns — 3 surface indicators (age outlier, multi-board membership, recent appointment) computable from ARES data alone. Returns indicator breakdown with riskScore 0-100. Pro Compliance tier or higher. For 8-indicator deep analysis including ISIR cross-reference, sanctions, address crowding and phoenix pattern, see detect_nominee_director_rich in @czagents/ddplus.',
    {
      ico: z.string().describe('Czech IČO — 7 or 8 digits.'),
    },
    { title: 'Detect Nominee Directors (Bílí koně)', readOnlyHint: true, openWorldHint: true },
    async ({ ico }) => {
      logToolCall('dd', 'detect_nominee_director', { ico });
      const gate = requireTier(tier, 'compliance', 'detect_nominee_director');
      if (gate) return gate;
      const clean = validateIcoInput(ico);
      trackIco(clean);
      const report = await buildReport(clean, clients, { depth: 'full' });
      const findings = detectNomineeDirector(report);
      return wrap(JSON.stringify(findings, null, 2));
    },
  );

  server.tool(
    'detect_phoenix',
    'Detect phoenix company pattern — 3 surface indicators (surname match with prior insolvent director, founding proximity < 12 months to insolvency, NACE sector presence) computable from ARES + ISIR data alone. Returns PhoenixReport with riskScore 0-100. Pro Compliance tier or higher. For 4 additional deep indicators (founder identity, asset transfer, multi-cycle, address continuity) see detect_phoenix_rich in @czagents/ddplus.',
    {
      ico: z.string().describe('Czech IČO — 7 or 8 digits.'),
    },
    { title: 'Detect Phoenix Company Pattern', readOnlyHint: true, openWorldHint: true },
    async ({ ico }) => {
      logToolCall('dd', 'detect_phoenix', { ico });
      const gate = requireTier(tier, 'compliance', 'detect_phoenix');
      if (gate) return gate;
      const clean = validateIcoInput(ico);
      trackIco(clean);
      const report = await buildReport(clean, clients, { depth: 'full' });
      const findings = detectPhoenix(report);
      return wrap(JSON.stringify(findings, null, 2));
    },
  );

  server.tool(
    'get_risk_timeline',
    'Build a chronologically sorted lifecycle timeline for a Czech company — basic events include company formation, statutory appointments, active insolvency, sanctions matches, VAT reliability flips. Returns events[] with riskScore 0-100. Pro Compliance tier or higher. For enriched timeline with ISIR lifecycle, address history, cross-entity events, and AI narrative summary, see get_risk_timeline_rich in @czagents/ddplus.',
    {
      ico: z.string().describe('Czech IČO — 7 or 8 digits.'),
    },
    { title: 'Get Risk Timeline (Časová osa rizika)', readOnlyHint: true, openWorldHint: true },
    async ({ ico }) => {
      logToolCall('dd', 'get_risk_timeline', { ico });
      const gate = requireTier(tier, 'compliance', 'get_risk_timeline');
      if (gate) return gate;
      const clean = validateIcoInput(ico);
      trackIco(clean);
      const report = await buildReport(clean, clients, { depth: 'full' });
      const result = buildTimeline(report);
      return wrap(JSON.stringify({ ico: clean, ...result }, null, 2));
    },
  );

  server.tool(
    'detect_address_crowding',
    'Detects "shell-firm hotel" patterns — counts how many companies share the same registered address. ' +
    'Threshold-based risk: 1-9 normal (multi-tenant office), 10-49 mild (legitimate coworking), ' +
    '50-199 medium (virtual office provider), 200+ high (shell-firm hotel). Compliance tier or higher.',
    { ico: z.string().describe('Czech IČO 7-8 digits') },
    { title: 'Detect Address Crowding', readOnlyHint: true, openWorldHint: true },
    async ({ ico }) => {
      logToolCall('dd', 'detect_address_crowding', { ico });
      const gate = requireTier(tier, 'compliance', 'detect_address_crowding');
      if (gate) return gate;
      const clean = validateIcoInput(ico);
      trackIco(clean);
      const company = await clients.ares.getByIco(clean);
      if (!company) {
        return wrap(JSON.stringify({ error: 'ico_not_found', ico: clean }));
      }
      const searchResult = await clients.ares.search({
        sidlo: {
          nazevUlice: company.sidlo?.nazevUlice,
          nazevObce: company.sidlo?.nazevObce,
          psc: company.sidlo?.psc,
        },
        pocet: 200,
      });
      const report = detectAddressCrowding({
        company,
        companiesAtAddress: searchResult.ekonomickeSubjekty,
        totalCountAtAddress: searchResult.pocetCelkem,
      });
      return wrap(JSON.stringify(report, null, 2));
    },
  );

  server.tool(
    'get_eu_dd_report',
    'EU Due-Diligence report for an international company. Input: 20-char LEI code, or company name + optional country. Returns GLEIF entity data (status, address, registration number) plus sanctions screening against EU/OFAC lists. Coverage notes per country included. Note: GLEIF covers mid/large firms with LEI — SMEs may not be found. Pro Compliance tier or higher.',
    {
      identifier: z.string().min(1).describe('20-char LEI code (e.g. "W38RGI023J3WT1HWRP32") or company name.'),
      country: z.string().length(2).optional().describe('ISO 3166-1 alpha-2 country code — helps narrow name search, not needed for LEI lookup.'),
    },
    { title: 'EU Due-Diligence Report (GLEIF + Sanctions)', readOnlyHint: true, openWorldHint: true },
    async ({ identifier, country }) => {
      logToolCall('dd', 'get_eu_dd_report', { identifier, country });
      const gate = requireTier(tier, 'compliance', 'get_eu_dd_report');
      if (gate) return gate;

      const isLei = /^[A-Z0-9]{18}[0-9]{2}$/i.test(identifier);

      let record = null;
      if (isLei) {
        record = await getByLei(identifier.toUpperCase());
      } else {
        const searchTerm = country ? `${identifier} ${country.toUpperCase()}` : identifier;
        const match = await lookupGleifParent(searchTerm);
        if (match) record = await getByLei(match.lei);
      }

      if (!record) {
        return wrap(JSON.stringify({
          error: 'not_found',
          identifier,
          message: 'No GLEIF-registered entity found.',
          coverage_note: 'GLEIF covers companies with a Legal Entity Identifier (LEI) — typically mid/large firms active in financial markets. SMEs are often not registered.',
        }, null, 2));
      }

      const sanctionsMatches = clients.sanctions
        ? clients.sanctions.searchByName(record.name, { typeFilter: 'entity', threshold: 0.8 })
        : [];

      const riskIndicators: string[] = [];
      if (record.status === 'dissolved') riskIndicators.push('ENTITY_DISSOLVED');
      if (sanctionsMatches.length > 0) riskIndicators.push(`SANCTIONS_MATCH(${sanctionsMatches.length})`);

      const coverageNotes: string[] = [
        'GLEIF: status, address, registration number. No insolvency, VAT, or UBO data.',
      ];
      if (record.country === 'de') coverageNotes.push('DE: Full Handelsregister (statutory bodies, filings) not integrated.');
      if (record.country === 'nl') coverageNotes.push('NL: Full KvK data (filings, directors) requires paid API.');
      if (record.country === 'pl') coverageNotes.push('PL: KRS full record available via get_company(id, "pl").');

      return wrap(JSON.stringify({
        identifier,
        company: record,
        sanctions: {
          checked: Boolean(clients.sanctions),
          matches: sanctionsMatches.slice(0, 5),
          source: clients.sanctions ? 'eu_fsf+ofac' : 'unavailable',
        },
        risk_indicators: riskIndicators,
        coverage: {
          registry_data: 'gleif_only',
          sanctions: clients.sanctions ? 'eu_fsf+ofac' : 'unavailable',
          notes: coverageNotes,
        },
      }, null, 2));
    },
  );

  server.tool(
    'get_eu_parent',
    'Find the EU/international parent company for a Czech IČO. Looks up the company name in ARES, then searches GLEIF (Global LEI Foundation) for a matching LEI-registered entity. Returns LEI, name, country, and confidence level (HIGH/MEDIUM/LOW). Note: GLEIF covers mid/large international firms; SMEs without an LEI will not be found. Pro Compliance tier or higher.',
    { ico: z.string().describe('Czech IČO — 7 or 8 digits.') },
    { title: 'Get EU Parent Company (ARES→GLEIF)', readOnlyHint: true, openWorldHint: true },
    async ({ ico }) => {
      logToolCall('dd', 'get_eu_parent', { ico });
      const gate = requireTier(tier, 'compliance', 'get_eu_parent');
      if (gate) return gate;
      const clean = validateIcoInput(ico);
      trackIco(clean);

      const subject = await clients.ares.getByIco(clean);
      if (!subject) {
        return wrap(JSON.stringify({ error: 'ico_not_found', ico: clean }));
      }

      const companyName = subject.obchodniJmeno ?? '';
      const match = await lookupGleifParent(companyName);

      return wrap(JSON.stringify({
        ico: clean,
        czech_name: companyName,
        eu_parent: match ?? null,
        ...(match == null && {
          note: 'No GLEIF-registered entity found. GLEIF coverage is limited to companies with a Legal Entity Identifier (LEI) — typically mid/large firms active in financial markets.',
        }),
      }, null, 2));
    },
  );

  return server;
}

function wrap(text: string) {
  return { content: [{ type: 'text' as const, text }] };
}
