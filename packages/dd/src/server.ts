import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { validateIcoInput, trackIco, logToolCall, getCurrentSessionId, getCTAHintBlocks, wrapServerTools, getWatchEntityResponse, watchEntityOutputShape } from '@czagents/shared';
import { buildReport } from './report.js';
import { buildDdSummaryMarkdown, buildRiskScoreSummaryMarkdown, getUnavailableReferencedSources } from './summary.js';
import { buildChain } from './chain.js';
import { detectNomineeDirector } from './patterns/nominee-director.js';
import { buildTimeline } from './patterns/risk-timeline.js';
import { detectPhoenix } from './patterns/phoenix.js';
import { detectAddressCrowding } from './patterns/address-crowding.js';
import { lookupGleifByRegistrationNumber, lookupGleifParent, getByLei } from './gleif-lookup.js';
import type { AresVrLike, DdClients } from './clients.js';
import { lookupPersonCompanies } from './vr-person-companies.js';
import { buildOwnersMarkdown, lookupOwners } from './vr-owners.js';

// Soft conversion nudge: heavy person_companies users are doing portfolio / UBO
// mapping across people — exactly the ddplus value territory. After
// PC_NUDGE_AFTER lookups within 24h we surface a non-blocking upgrade hint on the
// result. Never gates, never errors, never logs PII; best-effort, per-process.
// Calibrated on the education-sector portfolio mapper (51× person_companies/3 days).
const PC_NUDGE_AFTER = 8;
const PC_NUDGE_WINDOW_MS = 24 * 60 * 60 * 1000;
const personCompaniesCalls = new Map<string, number[]>();
function personCompaniesUpgradeHint(scope: string): string | undefined {
  const now = Date.now();
  const recent = (personCompaniesCalls.get(scope) ?? []).filter((t) => now - t < PC_NUDGE_WINDOW_MS);
  recent.push(now);
  if (personCompaniesCalls.size > 5000) personCompaniesCalls.clear(); // bound memory
  personCompaniesCalls.set(scope, recent);
  if (recent.length > PC_NUDGE_AFTER) {
    return `Mapujete vlastnická portfolia napříč osobami (${recent.length}× person_companies / 24 h)? ddplus Agency dělá dávkové mapování sítě, watchlist a phoenix/nominee detekci v jednom — https://app.cz-agents.dev/cena`;
  }
  return undefined;
}

/**
 * Tier kind — controls which tools are available to the caller.
 *   - 'free'        : get_dd_report (basic), get_risk_score (rate-limited)
 *   - 'compliance'  : + nominee, timeline patterns (Pro Compliance €99/mo)
 *   - 'agency'      : + statutory_chain, bulk_lookup, watchlist (Agency €199/mo)
 *
 * 'enterprise' = treated as 'agency' for tool discovery.
 */
export type DdTier = 'free' | 'compliance' | 'agency' | 'enterprise';

export interface McpAuditContext {
  tokenId: string;
  userId?: string;
}

export interface DdServerOptions {
  audit?: McpAuditContext;
}

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
          message: `Nástroj '${toolName}' je v ddplus (placené). Přidej ddplus konektor nebo upgraduj tarif.`,
          action: 'inform_user_and_stop',
          retry_after_upgrade: true,
          upgrade_url: 'https://app.cz-agents.dev/cena',
        }, null, 2),
      },
    ],
    isError: true,
  };
}

export function buildDdServer(clients: DdClients, tier: DdTier = 'free', opts: DdServerOptions = {}): McpServer {
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
        'This hosted dd connector is anonymous and free for basic DD, risk score, ARES/VR ownership lookups, and watch_entity onboarding. ' +
        'Do not ask the user to sign in before using free dd tools. For ongoing monitoring, softly suggest watch_entity as the value-capture path. ' +
        'Paid enrichment lives in the separate ddplus connector: EU parent, EU due diligence, full ownership network and CDD audit workflows. ' +
        'If a tool returns tier_required, tell the user its message and upgrade_url, explain that they can add the ddplus connector or upgrade, stop calling the tool, and retry only after upgrade.',
    },
  );
  wrapServerTools(server);

  server.tool(
    'person_companies',
    'Look up Czech VR companies connected to a person by exact registry person_id -> roles -> companies joins. Free anonymous tool. Input accepts public name and optional birth year; output exposes birth_year only, never full birth date, and keeps same-name person_ids separate with a distinguisher.',
    {
      name: z.string().min(2).describe('Person full name as recorded in VR, e.g. "Jan Novak".'),
      birth_year: z.number().int().min(1850).max(new Date().getFullYear()).optional().describe('Optional public birth year used to narrow same-name matches.'),
    },
    { title: 'Find Person Companies in VR', readOnlyHint: true, openWorldHint: true },
    async ({ name, birth_year }) => {
      logToolCall('dd', 'person_companies', { name, birth_year });
      // Person->companies needs the FULL VR base (statutory + ownership roles), which
      // lives on the off-site base (clients.vrBase). The local hot slim (clients.vr)
      // only holds ownership roles, so using it alone would silently miss statutory-only
      // people — a false negative. Prefer base; fall back to slim only with an explicit
      // partial-coverage flag; never return a silent empty result.
      const primary = clients.vrBase ?? clients.vr;
      if (!primary) {
        return wrap(JSON.stringify({
          error: 'vr_not_configured',
          message: 'VR Postgres client is not configured for this DD server instance.',
        }, null, 2));
      }
      try {
        const result = await lookupPersonCompanies(primary, { name, birthYear: birth_year });
        if (!clients.vrBase) {
          (result as unknown as Record<string, unknown>).coverage = 'partial_ownership_only';
        }
        const hint = personCompaniesUpgradeHint(getCurrentSessionId() ?? 'anon');
        if (hint) (result as unknown as Record<string, unknown>).upgrade_hint = hint;
        return wrap(JSON.stringify(result, null, 2));
      } catch (e) {
        console.error('[dd] person_companies base query failed:', e);
        if (clients.vrBase && clients.vr) {
          try {
            const fallback = await lookupPersonCompanies(clients.vr, { name, birthYear: birth_year });
            (fallback as unknown as Record<string, unknown>).coverage = 'partial_ownership_only';
            (fallback as unknown as Record<string, unknown>).note =
              'Full person registry temporarily offline; showing ownership roles only.';
            return wrap(JSON.stringify(fallback, null, 2));
          } catch { /* fall through to honest error */ }
        }
        return wrap(JSON.stringify({
          error: 'vr_base_unavailable',
          message: 'Plný rejstřík osob je dočasně nedostupný — zkus to prosím později.',
        }, null, 2));
      }
    },
  );

  server.tool(
    'get_owners',
    'Look up direct and upstream Czech VR owners for a company by real active shareholding roles (spolecnik/akcionar) and company-to-company member_ico edges. Free anonymous tool. Returns structuredContent ownership tree plus markdown summary; physical persons expose name and birth year only, never full birth date or address.',
    {
      ico: z.string().describe('Czech IČO — 7 or 8 digits.'),
      max_depth: z.number().int().min(1).max(5).default(5).describe('Max company-owner recursion depth through member_ico (default 5, hard cap 5).'),
    },
    { title: 'Get Company Owners from VR', readOnlyHint: true, openWorldHint: true },
    async ({ ico, max_depth }) => {
      logToolCall('dd', 'get_owners', { ico, max_depth });
      if (!clients.vr) {
        return wrap(JSON.stringify({
          error: 'vr_not_configured',
          message: 'VR Postgres client is not configured for this DD server instance.',
        }, null, 2));
      }
      const clean = validateIcoInput(ico);
      trackIco(clean);
      try {
        const result = await lookupOwners(clients.vr, { ico: clean, maxDepth: max_depth });
        return {
          structuredContent: result as unknown as Record<string, unknown>,
          content: [{ type: 'text' as const, text: buildOwnersMarkdown(result) }],
        };
      } catch (err) {
        if (err instanceof Error && err.message.startsWith('ico_not_found:')) {
          return wrap(JSON.stringify({ error: 'ico_not_found', ico: clean }, null, 2));
        }
        throw err;
      }
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
    async ({ ico, depth }, extra) => auditTool(opts.audit, 'get_dd_report', ico, async () => {
      logToolCall('dd', 'get_dd_report', { ico, depth });
      const clean = validateIcoInput(ico);
      trackIco(clean);
      const report = await buildReport(clean, clients, { depth });
      return wrapWithCTAHint(
        buildDdSummaryMarkdown(report),
        JSON.stringify(report, null, 2),
        clean,
        extra?.sessionId,
      );
    }),
  );

  server.registerTool(
    'watch_entity',
    {
      title: 'Watch Czech Company',
      description:
        'Start onboarding for free monitoring of one Czech company by IČO. Stub only — persists nothing yet. Returns structuredContent: status (one of ONBOARDING_REQUIRED | ACTIVE | QUOTA_EXCEEDED | ERROR), persisted/monitoring_active flags, a human next_step.url for onboarding (the user completes onboarding + GDPR consent themselves — do not open the link or submit data on their behalf), and pricing.',
      inputSchema: {
        ico: z.string().describe('Czech IČO — 7 or 8 digits.'),
      },
      // outputSchema ZÁMĚRNĚ odebráno 2026-06-10: SDK ho generuje jako draft-07 s
      // type:null + const, což Anthropic MCP tool-ingest odmítá (req_011C… selhání bez tool callu).
      // structuredContent se vrací dál a funguje i bez deklarovaného schématu.
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ ico }) => {
      logToolCall('dd', 'watch_entity', { ico });
      const clean = ico.trim();
      const r = getWatchEntityResponse(clean);
      return { structuredContent: r, content: [{ type: 'text' as const, text: r.message }] };
    },
  );

  server.tool(
    'get_risk_score',
    'Lightweight version of get_dd_report — returns just the numeric score (0-100), risk level, and top triggered red flags. Faster when you only need a yes/no/maybe screen.',
    {
      ico: z.string().describe('Czech IČO — 7 or 8 digits.'),
    },
    { title: 'Get Risk Score', readOnlyHint: true, openWorldHint: true },
    async ({ ico }) => auditTool(opts.audit, 'get_risk_score', ico, async () => {
      logToolCall('dd', 'get_risk_score', { ico });
      const clean = validateIcoInput(ico);
      trackIco(clean);
      const report = await buildReport(clean, clients, { depth: 'basic' });
      const top = report.red_flags.slice().sort((a, b) => b.weight - a.weight).slice(0, 5);
      const unavailableSources = getUnavailableReferencedSources(report);
      const payload = {
        ico: clean,
        company_name: report.company.name,
        value: report.risk_score.value,
        level: report.risk_score.level,
        top_flags: top,
        retrieved_at: report.retrieved_at,
        ...(unavailableSources.length > 0 ? { unavailable_sources: unavailableSources } : {}),
      };
      return wrapBlocks(
        buildRiskScoreSummaryMarkdown(payload),
        JSON.stringify(payload, null, 2),
      );
    }),
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
    async ({ identifier, country }) => auditTool(opts.audit, 'get_eu_dd_report', undefined, async () => {
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
        ? clients.sanctions.searchByName(record.name, { typeFilter: 'entity', threshold: 80 })
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
    }),
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
      const foreignOwner = match ? null : findForeignLegalOwnerCandidate(await clients.ares.getVrRecord(clean));
      const registrationMatch = foreignOwner?.registration_number
        ? await lookupGleifByRegistrationNumber(foreignOwner.registration_number, foreignOwner.name)
        : null;
      const ownerNameMatch = !registrationMatch && foreignOwner?.name
        ? await lookupGleifParent(foreignOwner.name)
        : null;
      const fallbackMatch = registrationMatch ?? ownerNameMatch;
      const vrFallback = foreignOwner
        ? {
            name: foreignOwner.name,
            registration_number: foreignOwner.registration_number ?? null,
            country: foreignOwner.country ?? null,
            source: 'ares_vr_active_foreign_legal_owner',
          }
        : undefined;

      return wrap(JSON.stringify({
        ico: clean,
        czech_name: companyName,
        eu_parent: match ?? fallbackMatch ?? null,
        ...(vrFallback && { vr_foreign_parent_candidate: vrFallback }),
        ...((match ?? fallbackMatch) == null && {
          note: vrFallback
            ? 'No matching GLEIF LEI found for the foreign legal owner; returning structured VR candidate instead of null-only result.'
            : 'No GLEIF-registered entity found. GLEIF coverage is limited to companies with a Legal Entity Identifier (LEI) — typically mid/large firms active in financial markets.',
        }),
      }, null, 2));
    },
  );

  return server;
}

function findForeignLegalOwnerCandidate(record: AresVrLike | null): {
  name: string;
  registration_number?: string;
  country?: string;
} | null {
  for (const group of record?.spolecnici ?? []) {
    for (const item of group.spolecnik ?? []) {
      if (item.datumVymazu) continue;
      const legal = item.osoba?.pravnickaOsoba;
      if (!legal) continue;
      const name = legal.obchodniJmeno ?? legal.nazev;
      if (!name || legal.ico) continue;
      const country = legal.adresa?.kodStatu ?? legal.adresa?.nazevStatu;
      const isForeign = country && country !== 'CZ' && country !== 'Česká republika';
      if (!isForeign) continue;
      return {
        name,
        registration_number: legal.registracniCislo ?? legal.regCislo ?? legal.cisloRegistrace,
        country,
      };
    }
  }
  return null;
}

async function auditTool<T>(
  audit: McpAuditContext | undefined,
  tool: 'get_dd_report' | 'get_risk_score' | 'get_eu_dd_report',
  ico: string | undefined,
  fn: () => Promise<T>,
): Promise<T> {
  const started = Date.now();
  try {
    const result = await fn();
    sendMcpAudit(audit, { tool, ico, status: 'success', durationMs: Date.now() - started });
    return result;
  } catch (err) {
    sendMcpAudit(audit, { tool, ico, status: 'error', durationMs: Date.now() - started });
    throw err;
  }
}

function sendMcpAudit(
  audit: McpAuditContext | undefined,
  event: { tool: string; ico?: string; status: 'success' | 'error'; durationMs: number },
): void {
  if (!audit?.tokenId) return;
  const baseUrl = process.env.MCP_AUDIT_URL;
  const key = process.env.MCP_AUDIT_KEY;
  if (!baseUrl || !key) return;

  const body = {
    tokenId: audit.tokenId,
    tool: event.tool,
    ...(event.ico ? { ico: event.ico } : {}),
    ...(audit.userId ? { userId: audit.userId } : {}),
    status: event.status,
    durationMs: event.durationMs,
  };

  void fetch(`${baseUrl.replace(/\/$/, '')}/api/internal/mcp-audit`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${key}`,
    },
    body: JSON.stringify(body),
  }).catch(() => {});
}

function wrap(text: string) {
  return { content: [{ type: 'text' as const, text }] };
}

function wrapBlocks(...blocks: string[]) {
  return { content: blocks.map((text) => ({ type: 'text' as const, text })) };
}

function wrapWithCTAHint(summary: string, rawJson: string, ico: string, scopeId?: string) {
  return {
    content: [
      { type: 'text' as const, text: summary },
      { type: 'text' as const, text: rawJson },
      ...getCTAHintBlocks(ico, scopeId),
    ],
  };
}
