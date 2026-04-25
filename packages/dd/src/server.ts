import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { validateIcoInput } from '@czagents/shared';
import { buildReport } from './report.js';
import { buildChain } from './chain.js';
import type { DdClients } from './clients.js';

export function buildDdServer(clients: DdClients): McpServer {
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
        'Use whenever the user asks for KYC / DD / company background check on a Czech IČO.',
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
    'Discover the statutory chain (UBO-style tree) for a Czech IČO. Walks: this company → its statutory persons → other companies they sit on → ... up to max_depth. Useful for KYC and shell-company unwinding.',
    {
      ico: z.string().describe('Czech IČO — 7 or 8 digits.'),
      max_depth: z.number().int().min(1).max(5).default(3).describe('Max recursion depth (default 3, hard cap 5).'),
    },
    async ({ ico, max_depth }) => {
      const clean = validateIcoInput(ico);
      const result = await buildChain(clean, clients.ares, { maxDepth: max_depth });
      return wrap(JSON.stringify(result, null, 2));
    },
  );

  return server;
}

function wrap(text: string) {
  return { content: [{ type: 'text' as const, text }] };
}
