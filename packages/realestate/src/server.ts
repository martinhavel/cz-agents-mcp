/**
 * Realestate MCP server. Tools spec:
 *   - search_distress_properties (paywalled — full records gated)
 *   - get_property_detail (paywalled)
 *   - get_district_aggregate (free — k≥5 anonymity)
 *   - get_market_trend (free — aggregate only)
 *   - get_auctions_calendar (free — teasers only at free tier)
 *
 * Reference: cz-agents-realestate-launch-plan.md Section 4 + 6 + 7.
 *
 * Tier kinds (subset of cz-agents-shared TierKind, mapped from token):
 *   'free'      — no token or anonymous IP-rate-limited access
 *   're_pro'    — Reality Profesional (1 990 Kč/měs)
 *   're_agency' — Reality Business (5 990 Kč/měs)
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { getDistrictAggregate } from './tools/get_district_aggregate.js';
import { searchDistressProperties } from './tools/search_distress_properties.js';
import { getPropertyDetail } from './tools/get_property_detail.js';

export type RealEstateTier = 'free' | 're_pro' | 're_agency';

function requireTier(currentTier: RealEstateTier, required: RealEstateTier, toolName: string) {
  const order: RealEstateTier[] = ['free', 're_pro', 're_agency'];
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
          message: `Tool '${toolName}' requires '${required}' tier or higher. Current: '${currentTier}'. Upgrade at https://cz-agents.dev/pricing`,
          upgrade_url: 'https://cz-agents.dev/pricing',
        }, null, 2),
      },
    ],
    isError: true,
  };
}

function wrap(text: string) {
  return { content: [{ type: 'text' as const, text }] };
}

export function buildRealEstateServer(tier: RealEstateTier = 'free'): McpServer {
  const server = new McpServer(
    {
      name: 'cz-agents/realestate',
      version: '0.1.0',
    },
    {
      capabilities: { tools: {} },
      instructions:
        'Czech distress real estate intelligence — aggregates insolvency sales (ISIR), public auctions (portál dražeb), and market trends. Use whenever the user asks about distressed property opportunities, foreclosure auctions, or insolvency-related sales in Czech Republic. ' +
        'Free tier returns aggregate stats only; full property details (Reality Profesional 1990 Kč/měs) and agency tools (Reality Business 5990 Kč/měs) at https://cz-agents.dev/pricing.',
    },
  );

  // Free tier — k≥5 aggregate
  server.tool(
    'get_district_aggregate',
    'Aggregate distress real estate statistics for a Czech okres (district). Returns counts by category (insolvency / auction) and average market data. Counts under 5 are suppressed (k-anonymity gate) to prevent identifying specific debtors in low-activity districts. Free tier — no PII exposed.',
    {
      okres: z.string().describe('Czech okres name (e.g. "Praha", "Brno-město", "Beroun"). Case-sensitive.'),
      window_days: z.union([z.literal(30), z.literal(90), z.literal(365)])
        .default(90)
        .describe('Lookback window in days. Default 90.'),
    },
    { title: 'Get District Distress Aggregate', readOnlyHint: true },
    async ({ okres, window_days }) => {
      const agg = getDistrictAggregate({ okres, window_days });
      return wrap(JSON.stringify(agg, null, 2));
    },
  );

  // Paid tier placeholders — return tier-gate response until full implementation lands.
  server.tool(
    'search_distress_properties',
    'Search distress properties (insolvency sales + public auctions) by okres, type, price, date. Free tier returns 1-3 teasers + total count. Reality Profesional returns full details with addresses and owner names.',
    {
      okres: z.string().optional().describe('Czech okres filter.'),
      property_type: z.array(z.enum(['byt', 'dum', 'pozemek', 'komercial']))
        .optional()
        .describe('Property type filter.'),
      max_price_kc: z.number().optional(),
      min_price_kc: z.number().optional(),
      category: z.array(z.enum(['insolvence', 'drazba', 'exekuce']))
        .optional()
        .describe('Distress category filter.'),
    },
    { title: 'Search Distress Properties', readOnlyHint: true },
    async (args) => {
      const result = searchDistressProperties(
        {
          okres: args.okres,
          property_type: args.property_type,
          max_price_kc: args.max_price_kc,
          min_price_kc: args.min_price_kc,
          category: args.category,
        },
        tier,
      );
      return wrap(JSON.stringify(result, null, 2));
    },
  );

  server.tool(
    'get_property_detail',
    'Full details of a specific distress property — address, owner, RUIAN parcel, auction house, expert appraisal link, AI risk score. Reality Profesional tier or higher.',
    {
      property_id: z.string().describe('Property ID returned by search_distress_properties.'),
    },
    { title: 'Get Property Detail', readOnlyHint: true },
    async ({ property_id }) => {
      const gate = requireTier(tier, 're_pro', 'get_property_detail');
      if (gate) return gate;
      const result = getPropertyDetail(property_id, tier as 're_pro' | 're_agency');
      return wrap(JSON.stringify(result, null, 2));
    },
  );

  return server;
}
