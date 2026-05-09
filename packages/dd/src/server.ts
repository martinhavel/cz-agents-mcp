import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { validateIcoInput } from '@czagents/shared';
import { buildReport } from './report.js';
import { buildChain } from './chain.js';
import { detectNomineeDirector } from './patterns/nominee-director.js';
import { buildTimeline } from './patterns/risk-timeline.js';
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
          message: `Tool '${toolName}' requires '${required}' tier or higher. Current: '${currentTier}'. Upgrade at https://app.cz-agents.dev/billing`,
          upgrade_url: 'https://cz-agents.dev/pricing',
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
        'Free tier (basic report) rate-limited; Compliance and Agency tiers (more tools, higher quotas) at https://cz-agents.dev/pricing.',
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
      const clean = validateIcoInput(ico);
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
      const clean = validateIcoInput(ico);
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
      const gate = requireTier(tier, 'agency', 'get_statutory_chain');
      if (gate) return gate;
      const clean = validateIcoInput(ico);
      const result = await buildChain(clean, clients.ares, { maxDepth: max_depth });
      return wrap(JSON.stringify(result, null, 2));
    },
  );

  // 2026-05-08 — Pro Compliance tier exclusive (= compliance + agency).
  server.tool(
    'detect_nominee_director',
    'Detect "white horse" / nominee director patterns — 8 independent indicators including residence at municipal office, multi-board membership, personal insolvency, prior bankrupt companies, recent appointment, shared flagged address, and HQ matching residence. Returns indicator-by-indicator breakdown with descriptions for compliance audit. Pro Compliance tier or higher.',
    {
      ico: z.string().describe('Czech IČO — 7 or 8 digits.'),
    },
    { title: 'Detect Nominee Directors (Bílí koně)', readOnlyHint: true, openWorldHint: true },
    async ({ ico }) => {
      const gate = requireTier(tier, 'compliance', 'detect_nominee_director');
      if (gate) return gate;
      const clean = validateIcoInput(ico);
      const report = await buildReport(clean, clients, { depth: 'full' });
      const findings = detectNomineeDirector(report);
      return wrap(JSON.stringify(findings, null, 2));
    },
  );

  server.tool(
    'get_risk_timeline',
    'Build a chronologically sorted lifecycle timeline for a Czech company — events include company formation, statutory member appointments, insolvency proceedings, sanctions matches, VAT reliability flips, etc. For audit narrative and "story so far" reports. Pro Compliance tier or higher.',
    {
      ico: z.string().describe('Czech IČO — 7 or 8 digits.'),
    },
    { title: 'Get Risk Timeline (Časová osa rizika)', readOnlyHint: true, openWorldHint: true },
    async ({ ico }) => {
      const gate = requireTier(tier, 'compliance', 'get_risk_timeline');
      if (gate) return gate;
      const clean = validateIcoInput(ico);
      const report = await buildReport(clean, clients, { depth: 'full' });
      const events = buildTimeline(report);
      return wrap(JSON.stringify({ ico: clean, events }, null, 2));
    },
  );

  return server;
}

function wrap(text: string) {
  return { content: [{ type: 'text' as const, text }] };
}
