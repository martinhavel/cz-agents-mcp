import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { logToolCall, wrapServerTools } from '@czagents/shared';
import { CnbClient } from './client.js';

export function buildCnbServer(): McpServer {
  const server = new McpServer(
    {
      name: 'cz-agents/cnb',
      version: '0.1.0',
    },
    {
      capabilities: { tools: {} },
      instructions:
        'Czech National Bank (ČNB) daily FX rates. Use these tools to get official CZK exchange ' +
        'rates, convert between currencies, or fetch historical rates for invoicing/accounting. ' +
        'Part of the cz-agents MCP suite — companion servers for Czech business data:\n' +
        '• ares.cz-agents.dev/mcp — Czech Business Register (IČO lookup, VAT, bank accounts)\n' +
        '• dd.cz-agents.dev/mcp — full due diligence (ownership, risk score, statutory chain)\n' +
        '• sanctions.cz-agents.dev/mcp — EU FSF + OFAC sanctions screening\n' +
        'Free tier rate-limited; higher limits at https://cz-agents.dev/pricing.html.',
    },
  );
  wrapServerTools(server);

  const cnb = new CnbClient();

  server.tool(
    'get_rates',
    'Get official CZK exchange rates published by ČNB. Returns all currencies from the daily sheet (~31 majors). Optional `date` parameter (YYYY-MM-DD) for historical rates; otherwise returns latest.',
    {
      date: z
        .string()
        .regex(/^\d{4}-\d{2}-\d{2}$/)
        .optional()
        .describe('Optional ISO date (YYYY-MM-DD) for historical rates. Omit for latest.'),
    },
    { title: 'Get ČNB Daily FX Rates', readOnlyHint: true, openWorldHint: true },
    async ({ date }) => {
      logToolCall('cnb', 'get_rates');
      const sheet = await cnb.getDailyRates(date);
      const summary = sheet.rates
        .map((r) => `${r.code}  ${r.amount} ${r.currencyName} = ${r.rate} CZK`)
        .join('\n');
      return {
        content: [
          {
            type: 'text',
            text: `Kurzovní lístek ČNB ${sheet.date} (#${sheet.sequence}):\n\n${summary}\n\nFull JSON:\n${JSON.stringify(sheet, null, 2)}`,
          },
        ],
      };
    },
  );

  server.tool(
    'convert',
    'Convert an amount between two currencies using official ČNB rates. E.g., convert 100 EUR to CZK, or 50 USD to GBP (goes via CZK cross-rate). Optional `date` for historical conversion.',
    {
      amount: z.number().describe('Amount to convert.'),
      from: z
        .string()
        .length(3)
        .describe('Source currency ISO 4217 code (e.g., "EUR", "USD", "CZK").'),
      to: z.string().length(3).describe('Target currency ISO 4217 code.'),
      date: z
        .string()
        .regex(/^\d{4}-\d{2}-\d{2}$/)
        .optional()
        .describe('Optional ISO date for historical rates. Omit for latest.'),
    },
    { title: 'Convert Currency via ČNB Rates', readOnlyHint: true, openWorldHint: true },
    async ({ amount, from, to, date }) => {
      logToolCall('cnb', 'convert');
      const result = await cnb.convert(amount, from, to, date);
      return {
        content: [
          {
            type: 'text',
            text: `${result.amount.toFixed(2)} ${result.to}\n\n(${amount} ${result.from} × ${result.rate} = ${result.amount.toFixed(4)} ${result.to}, kurz ČNB ${result.sheetDate})`,
          },
        ],
      };
    },
  );

  server.tool(
    'get_rate',
    'Quick single-currency lookup. Returns just the CZK rate for one currency (or all rates if no code given).',
    {
      code: z
        .string()
        .length(3)
        .describe('ISO 4217 currency code (e.g., "EUR", "USD", "GBP").'),
      date: z
        .string()
        .regex(/^\d{4}-\d{2}-\d{2}$/)
        .optional()
        .describe('Optional ISO date for historical rate.'),
    },
    { title: 'Get Single Currency ČNB Rate', readOnlyHint: true, openWorldHint: true },
    async ({ code, date }) => {
      logToolCall('cnb', 'get_rate');
      const sheet = await cnb.getDailyRates(date);
      const r = sheet.rates.find((x) => x.code === code.toUpperCase());
      if (!r) {
        return {
          content: [{ type: 'text', text: `Měna ${code.toUpperCase()} nenalezena v ČNB lístku ${sheet.date}.` }],
          isError: true,
        };
      }
      return {
        content: [
          {
            type: 'text',
            text: `${r.amount} ${r.code} = ${r.rate} CZK  (${r.country}, ${r.currencyName})\nKurz ČNB ${sheet.date} #${sheet.sequence}`,
          },
        ],
      };
    },
  );

  return server;
}
