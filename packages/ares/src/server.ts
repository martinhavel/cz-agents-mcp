import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { validateIcoInput } from '@czagents/shared';
import { AresClient } from './client.js';

/**
 * Build an MCP server exposing ARES (Czech Business Register) tools.
 * Transport-agnostic — wrap with stdio or streamable-http in entry files.
 */
export function buildAresServer(): McpServer {
  const server = new McpServer(
    {
      name: 'cz-agents/ares',
      version: '0.1.0',
    },
    {
      capabilities: { tools: {} },
      instructions:
        'Czech Business Register (ARES) lookup. Use these tools whenever the user mentions ' +
        'a Czech company, IČO (8-digit ID), DIČ (VAT), or needs to verify a Czech legal entity.',
    },
  );

  const ares = new AresClient();

  server.tool(
    'lookup_by_ico',
    'Get a single Czech company record by its IČO (8-digit Business ID). Returns official name, registered address, legal form, VAT ID (DIČ), founding date, and trade license activities. Returns null if IČO is not found in ARES.',
    {
      ico: z
        .string()
        .describe('Czech IČO — 7 or 8 digits. Examples: "27074358", "61388581". Auto-validated with MOD11 checksum.'),
    },
    async ({ ico }) => {
      const clean = validateIcoInput(ico);
      const subject = await ares.getByIco(clean);
      if (!subject) {
        return {
          content: [
            { type: 'text', text: `Žádný subjekt s IČO ${clean} v ARES nenalezen.` },
          ],
        };
      }
      return {
        content: [{ type: 'text', text: JSON.stringify(subject, null, 2) }],
      };
    },
  );

  server.tool(
    'search_companies',
    'Full-text search ARES by company name or other filters. Useful when the user knows the name but not the IČO. Returns up to 100 results with IČO, name, and address.',
    {
      query: z.string().describe('Partial or full company name (obchodní jméno).').optional(),
      city: z.string().describe('Filter by city (nazev obce).').optional(),
      psc: z.number().int().describe('Filter by postal code (PSČ).').optional(),
      pocet: z
        .number()
        .int()
        .min(1)
        .max(100)
        .default(10)
        .describe('Max results to return (1-100, default 10).'),
      start: z
        .number()
        .int()
        .min(0)
        .default(0)
        .describe('Pagination offset (default 0).'),
    },
    async ({ query, city, psc, pocet, start }) => {
      const result = await ares.search({
        query,
        sidlo: city || psc ? { nazevObce: city, psc } : undefined,
        pocet,
        start,
      });
      const summary = result.ekonomickeSubjekty
        .map(
          (s) =>
            `${s.ico}  ${s.obchodniJmeno ?? '(bez jména)'} — ${
              s.sidlo?.textovaAdresa ?? 'bez adresy'
            }`,
        )
        .join('\n');
      return {
        content: [
          {
            type: 'text',
            text: `Nalezeno ${result.pocetCelkem} subjektů (zobrazeno ${result.ekonomickeSubjekty.length}):\n\n${summary}\n\nFull JSON:\n${JSON.stringify(result, null, 2)}`,
          },
        ],
      };
    },
  );

  server.tool(
    'get_bank_accounts',
    'Get transparent bank accounts published for this company (only available for VAT-registered subjects). Useful to verify payment details on an invoice match the company.',
    {
      ico: z.string().describe('Czech IČO (7-8 digits).'),
    },
    async ({ ico }) => {
      const clean = validateIcoInput(ico);
      const accounts = await ares.getBankAccounts(clean);
      if (accounts.length === 0) {
        return {
          content: [
            {
              type: 'text',
              text: `Subjekt ${clean} nemá v ARES zveřejněné žádné transparentní účty (nebo není plátce DPH).`,
            },
          ],
        };
      }
      const summary = accounts
        .map(
          (a) =>
            `${a.cisloUctu}/${a.kodBanky} (${a.menaUctu ?? 'CZK'}) — zveřejněno ${a.datumZverejneni ?? 'N/A'}`,
        )
        .join('\n');
      return {
        content: [
          {
            type: 'text',
            text: `Transparentní účty subjektu ${clean}:\n${summary}`,
          },
        ],
      };
    },
  );

  server.tool(
    'get_history',
    'Get historical record of a company (previous names, registered address changes, trade license history). Useful for due diligence.',
    {
      ico: z.string().describe('Czech IČO (7-8 digits).'),
    },
    async ({ ico }) => {
      const clean = validateIcoInput(ico);
      const history = await ares.getHistory(clean);
      if (!history) {
        return {
          content: [
            { type: 'text', text: `Žádná historie pro IČO ${clean} není v ARES k dispozici.` },
          ],
        };
      }
      return {
        content: [{ type: 'text', text: JSON.stringify(history, null, 2) }],
      };
    },
  );

  return server;
}
