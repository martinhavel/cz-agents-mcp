/**
 * Realestate MCP server — FREE TIER ONLY (v0.2.0+).
 *
 * Tools:
 *   - get_district_aggregate (free — k<5 banding, public-registry source)
 *   - get_market_trend       (free — aggregate only)
 *
 * Paid tools (search_distress_properties, get_property_detail) have been
 * moved to the hosted closed-source realestate-pro service:
 *   https://realestate-pro.cz-agents.dev/mcp
 * See https://cz-agents.dev/pricing.html for subscription details.
 *
 * Reference: cz-agents-realestate-launch-plan.md Section 4 + 6 + 7.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { logToolCall, wrapServerTools } from '@czagents/shared';
import { getDistrictAggregate } from './tools/get_district_aggregate.js';

export type RealEstateTier = 'free';

function wrap(text: string) {
  return { content: [{ type: 'text' as const, text }] };
}

export function buildRealEstateServer(_tier: RealEstateTier = 'free'): McpServer {
  const server = new McpServer(
    {
      name: 'cz-agents/realestate',
      version: '0.3.0',
    },
    {
      capabilities: { tools: {} },
      instructions:
        'Czech distress real estate intelligence — free aggregate tools. ' +
        'Returns anonymised district-level statistics (insolvency counts, auction counts, price trends). ' +
        'Full property search, owner data, and per-property details are available at the hosted ' +
        'realestate-pro endpoint (https://realestate-pro.cz-agents.dev/mcp) — see https://cz-agents.dev/pricing.html.',
    },
  );
  wrapServerTools(server);

  // Free tier — aggregate of public registries (ISIR + portál dražeb/CEVD); counts of 1–4 banded to "<5"
  server.tool(
    'get_district_aggregate',
    'Aggregate distress real estate statistics for a Czech okres (district) from public registries (ISIR insolvencies + portál dražeb / CEVD forced sales). Returns counts by category (insolvency / auction) and average market data. To avoid identifying an individual, districts with 1–4 distress leads return null counts plus counts_band="<5" (records exist, exact figure withheld); 0 is shown as 0, ≥5 exact. low_activity flags k<5. Free tier — no per-person PII (no names/addresses).',
    {
      okres: z.string().describe('Czech okres name (e.g. "Praha", "Brno-město", "Beroun"). Case-sensitive.'),
      window_days: z.union([z.literal(30), z.literal(90), z.literal(365)])
        .default(90)
        .describe('Lookback window in days. Default 90.'),
    },
    { title: 'Get District Distress Aggregate', readOnlyHint: true },
    async ({ okres, window_days }) => {
      logToolCall('realestate', 'get_district_aggregate');
      const agg = getDistrictAggregate({ okres, window_days });
      return wrap(JSON.stringify(agg, null, 2));
    },
  );

  return server;
}
