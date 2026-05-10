/**
 * Realestate MCP server — FREE TIER ONLY (v0.2.0+).
 *
 * Tools:
 *   - get_district_aggregate (free — k≥5 anonymity)
 *   - get_market_trend       (free — aggregate only)
 *
 * Paid tools (search_distress_properties, get_property_detail) have been
 * moved to the hosted closed-source realestate-pro service:
 *   https://realestate-pro.cz-agents.dev/mcp
 * See https://cz-agents.dev/pricing for subscription details.
 *
 * Reference: cz-agents-realestate-launch-plan.md Section 4 + 6 + 7.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { getDistrictAggregate } from './tools/get_district_aggregate.js';

export type RealEstateTier = 'free';

function wrap(text: string) {
  return { content: [{ type: 'text' as const, text }] };
}

export function buildRealEstateServer(_tier: RealEstateTier = 'free'): McpServer {
  const server = new McpServer(
    {
      name: 'cz-agents/realestate',
      version: '0.2.0',
    },
    {
      capabilities: { tools: {} },
      instructions:
        'Czech distress real estate intelligence — free aggregate tools. ' +
        'Returns anonymised district-level statistics (insolvency counts, auction counts, price trends). ' +
        'Full property search, owner data, and per-property details are available at the hosted ' +
        'realestate-pro endpoint (https://realestate-pro.cz-agents.dev/mcp) — see https://cz-agents.dev/pricing.',
    },
  );

  // Free tier — k≥5 aggregate, no PII
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

  return server;
}
