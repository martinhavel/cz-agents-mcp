import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { validateIcoInput, isValidDic, icoFromDic, formatDic, trackIco, logToolCall, getCTAHintBlocks, wrapServerTools, getWatchEntityResponse, watchEntityOutputShape } from '@czagents/shared';
import { AresClient } from './client.js';
import { buildAresSummaryMarkdown } from './summary.js';

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
        'a Czech company, IČO (8-digit ID), DIČ (VAT), or needs to verify a Czech legal entity. ' +
        'Part of the cz-agents MCP suite — companion servers for deeper analysis:\n' +
        '• dd.cz-agents.dev/mcp — full due diligence (ownership structure, risk score, statutory chain, phoenix detection)\n' +
        '• sanctions.cz-agents.dev/mcp — EU FSF + OFAC sanctions screening\n' +
        '• isir.cz-agents.dev/mcp — Czech insolvency register (ISIR)\n' +
        '• cnb.cz-agents.dev/mcp — Czech National Bank (FX rates, licensed entities)\n' +
        'Free tier rate-limited; higher limits at https://cz-agents.dev/pricing.html.',
    },
  );
  wrapServerTools(server);

  const ares = new AresClient();

  server.tool(
    'lookup_by_ico',
    'Get a single Czech company record by its IČO (8-digit Business ID). Returns official name, registered address, legal form, VAT ID (DIČ), founding date, and trade license activities. Returns null if IČO is not found in ARES.',
    {
      ico: z
        .string()
        .describe('Czech IČO — 7 or 8 digits. Examples: "11122234", "87654326". Auto-validated with MOD11 checksum.'),
    },
    { title: 'Look Up Czech Company by IČO', readOnlyHint: true, openWorldHint: true },
    async ({ ico }, extra) => {
      logToolCall('ares', 'lookup_by_ico', { ico });
      const clean = validateIcoInput(ico);
      trackIco(clean);
      const subject = await ares.getByIco(clean);
      if (!subject) {
        return {
          content: [
            { type: 'text', text: `Žádný subjekt s IČO ${clean} v ARES nenalezen.` },
            ...getCTAHintBlocks(clean, extra?.sessionId),
          ],
        };
      }
      return {
        content: [
          { type: 'text', text: buildAresSummaryMarkdown(subject) },
          { type: 'text', text: JSON.stringify(subject, null, 2) },
          ...getCTAHintBlocks(clean, extra?.sessionId),
        ],
      };
    },
  );

  server.tool(
    'search_companies',
    'Search ARES by company name, city, street, PSČ, or NACE code. Combines all filters with AND. Useful when user knows name but not IČO, looking for companies in a building, or all businesses in a sector.',
    {
      query: z.string().describe('Partial or full company name (obchodní jméno).').optional(),
      city: z.string().describe('Filter by city (nazev obce), e.g. "Praha".').optional(),
      street: z.string().describe('Filter by street name (nazev ulice), e.g. "Radlická".').optional(),
      psc: z.number().int().describe('Filter by postal code (PSČ), 5-digit number.').optional(),
      nace: z
        .array(z.string())
        .describe('Filter by CZ-NACE activity codes, 2-6 digits. E.g., ["62"] for IT.')
        .optional(),
      pocet: z.number().int().min(1).max(100).default(10)
        .describe('Max results (1-100, default 10).'),
      start: z.number().int().min(0).default(0)
        .describe('Pagination offset (default 0).'),
    },
    { title: 'Search Czech Companies', readOnlyHint: true, openWorldHint: true },
    async ({ query, city, street, psc, nace, pocet, start }) => {
      const normalizedQuery = query?.replace(/_/g, ' ').replace(/\s+/g, ' ').trim();
      logToolCall('ares', 'search_companies', { query: normalizedQuery, city, street, psc, nace, pocet, start });
      const sidlo = city || street || psc
        ? { nazevObce: city, nazevUlice: street, psc }
        : undefined;
      const result = await ares.search({
        query: normalizedQuery, sidlo, czNace: nace, pocet, start,
      });
      const summary = result.ekonomickeSubjekty
        .map((s) =>
          `${s.ico}  ${s.obchodniJmeno ?? '(bez jména)'} — ${s.sidlo?.textovaAdresa ?? 'bez adresy'}`,
        )
        .join('\n');
      return {
        content: [
          {
            type: 'text',
            text: `Nalezeno ${result.pocetCelkem} subjektů (zobrazeno ${result.ekonomickeSubjekty.length}):\n\n${summary}`,
          },
        ],
      };
    },
  );

  server.tool(
    'search_by_address',
    'Find all companies registered at a given Czech address. Useful for due diligence (virtual offices, shell companies), real estate research, or competitor mapping in a building.',
    {
      street: z.string().describe('Street name (nazev ulice), e.g. "Radlická".'),
      city: z.string().describe('City name, e.g. "Praha".'),
      psc: z.number().int().describe('Postal code (PSČ), optional.').optional(),
      pocet: z.number().int().min(1).max(100).default(20)
        .describe('Max results (default 20).'),
    },
    { title: 'Search Companies by Address', readOnlyHint: true, openWorldHint: true },
    async ({ street, city, psc, pocet }) => {
      logToolCall('ares', 'search_by_address', { street, city, psc, pocet });
      const result = await ares.search({
        sidlo: { nazevUlice: street, nazevObce: city, psc },
        pocet,
      });
      if (result.pocetCelkem === 0) {
        return { content: [{ type: 'text', text: `Na adrese "${street}, ${city}" není v ARES žádný subjekt.` }] };
      }
      const lines = [
        `Firmy na adrese ${street}, ${city}${psc ? ` (${psc})` : ''}:`,
        `Celkem ${result.pocetCelkem}, zobrazeno ${result.ekonomickeSubjekty.length}.`,
        '',
      ];
      for (const s of result.ekonomickeSubjekty) {
        lines.push(`  ${s.ico} — ${s.obchodniJmeno ?? '(bez jména)'}`);
      }
      return { content: [{ type: 'text', text: lines.join('\n') }] };
    },
  );

  server.tool(
    'search_by_nace',
    'Find Czech companies by CZ-NACE activity code (economic sector classification). Example: "62" = IT, "47" = retail, "86" = healthcare. Optional city filter. Useful for market research.',
    {
      nace: z.string().describe('CZ-NACE code, 2-6 digits (e.g., "62" for IT, "62010" for programming services).'),
      city: z.string().describe('Optional city filter.').optional(),
      pocet: z.number().int().min(1).max(100).default(20).describe('Max results.'),
    },
    { title: 'Search Companies by NACE Code', readOnlyHint: true, openWorldHint: true },
    async ({ nace, city, pocet }) => {
      logToolCall('ares', 'search_by_nace', { nace, city, pocet });
      const result = await ares.search({
        czNace: [nace],
        sidlo: city ? { nazevObce: city } : undefined,
        pocet,
      });
      if (result.pocetCelkem === 0) {
        return { content: [{ type: 'text', text: `Žádné firmy s CZ-NACE ${nace}${city ? ` v ${city}` : ''}.` }] };
      }
      const lines = [
        `CZ-NACE ${nace}${city ? `, město ${city}` : ''}:`,
        `Celkem ${result.pocetCelkem}, zobrazeno ${result.ekonomickeSubjekty.length}.`,
        '',
      ];
      for (const s of result.ekonomickeSubjekty) {
        lines.push(`  ${s.ico} — ${s.obchodniJmeno ?? '(bez jména)'} — ${s.sidlo?.textovaAdresa ?? '-'}`);
      }
      return { content: [{ type: 'text', text: lines.join('\n') }] };
    },
  );

  server.tool(
    'get_bank_accounts',
    'Get transparent bank accounts published for this company (only available for VAT-registered subjects). Useful to verify payment details on an invoice match the company.',
    {
      ico: z.string().describe('Czech IČO (7-8 digits).'),
    },
    { title: 'Get Transparent Bank Accounts', readOnlyHint: true, openWorldHint: true },
    async ({ ico }) => {
      logToolCall('ares', 'get_bank_accounts', { ico });
      const clean = validateIcoInput(ico);
      trackIco(clean);
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
    'get_statutaries',
    'Get current statutory body (jednatelé, představenstvo, etc.) of a Czech company — who can legally act on its behalf. Returns active members only (with valid zápis, not yet removed). Essential for due diligence and compliance checks.',
    {
      ico: z.string().describe('Czech IČO (7-8 digits).'),
    },
    { title: 'Get Statutory Body', readOnlyHint: true, openWorldHint: true },
    async ({ ico }, extra) => {
      logToolCall('ares', 'get_statutaries', { ico });
      const clean = validateIcoInput(ico);
      trackIco(clean);
      const vr = await ares.getVrRecord(clean);
      if (!vr) {
        return {
          content: [
            { type: 'text', text: `Subjekt ${clean} nemá záznam ve Veřejném rejstříku.` },
            ...getCTAHintBlocks(clean, extra?.sessionId),
          ],
        };
      }
      const active = (vr.statutarniOrgany ?? []).filter((o) => !o.datumVymazu);
      if (active.length === 0) {
        return {
          content: [
            { type: 'text', text: `Subjekt ${clean} (${vr.obchodniJmeno ?? '-'}) nemá aktuální statutární orgán.` },
            ...getCTAHintBlocks(clean, extra?.sessionId),
          ],
        };
      }
      const lines: string[] = [`${vr.obchodniJmeno ?? clean} — aktuální statutární orgány:`, ''];
      for (const organ of active) {
        lines.push(`▸ ${organ.nazevOrganu ?? '—'}`);
        const activeMembers = (organ.clenoveOrganu ?? []).filter((m) => !m.datumVymazu);
        if (activeMembers.length === 0) {
          lines.push('  (bez aktuálních členů)');
        }
        for (const m of activeMembers) {
          const fo = m.fyzickaOsoba;
          const po = m.pravnickaOsoba;
          const funkce = m.funkce?.nazev ?? 'člen';
          if (fo) {
            const jmeno = [fo.titulPredJmenem, fo.jmeno, fo.prijmeni, fo.titulZaJmenem]
              .filter(Boolean).join(' ').trim();
            lines.push(`  • ${funkce}: ${jmeno}${fo.datumNarozeni ? ` (nar. ${fo.datumNarozeni})` : ''}`);
          } else if (po) {
            lines.push(`  • ${funkce}: ${po.obchodniJmeno ?? '-'} (IČO ${po.ico ?? '?'})`);
          }
        }
      }
      return { content: [{ type: 'text', text: lines.join('\n') }] };
    },
  );

  server.tool(
    'validate_dic',
    'Validate a Czech DIČ (VAT ID). Format check: "CZ" + 8-10 digits. For 8-digit tail (legal entities) also runs MOD11 checksum against the embedded IČO.',
    {
      dic: z.string().describe('Czech DIČ — e.g., "CZ26168685". Whitespace and case tolerated.'),
    },
    { title: 'Validate Czech DIČ', readOnlyHint: true },
    async ({ dic }) => {
      logToolCall('ares', 'validate_dic', { dic });
      const formatted = formatDic(dic);
      const valid = isValidDic(dic);
      const embedded = icoFromDic(dic);
      if (!valid) {
        return {
          content: [{ type: 'text', text: `DIČ "${formatted}" NENÍ platné (špatný formát nebo checksum).` }],
          isError: true,
        };
      }
      const hint = embedded
        ? ` Obsažené IČO: ${embedded} — použij lookup_by_ico pro detaily firmy.`
        : ' (personální DIČ — rodné číslo, detaily nelze dohledat přes ARES).';
      return {
        content: [{ type: 'text', text: `DIČ ${formatted} je platné formátem i checksum.${hint}` }],
      };
    },
  );

  server.tool(
    'check_vat_payer',
    'Check whether a Czech company is a registered VAT payer (plátce DPH). If yes, returns DIČ, financial office, and any transparent bank accounts (payment details).',
    {
      ico: z.string().describe('Czech IČO (7-8 digits).'),
    },
    { title: 'Check VAT Payer Status', readOnlyHint: true, openWorldHint: true },
    async ({ ico }) => {
      logToolCall('ares', 'check_vat_payer', { ico });
      const clean = validateIcoInput(ico);
      trackIco(clean);
      const subject = await ares.getByIco(clean);
      if (!subject) {
        return {
          content: [{ type: 'text', text: `Subjekt s IČO ${clean} v ARES nenalezen.` }],
        };
      }
      if (!subject.dic) {
        return {
          content: [
            {
              type: 'text',
              text: `${subject.obchodniJmeno ?? clean} — NENÍ registrovaný plátce DPH v ARES (bez DIČ).`,
            },
          ],
        };
      }
      const accounts = await ares.getBankAccounts(clean);
      const accountStr = accounts.length > 0
        ? '\n\nTransparentní účty:\n' + accounts.map((a) => `  ${a.cisloUctu}/${a.kodBanky} (${a.menaUctu ?? 'CZK'})`).join('\n')
        : '\n(Žádné transparentní účty zveřejněny.)';
      return {
        content: [
          {
            type: 'text',
            text: `${subject.obchodniJmeno ?? clean} — PLÁTCE DPH.\nDIČ: ${subject.dic}\nFinanční úřad: ${subject.financniUrad ?? 'neznámý'}${accountStr}`,
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
    { title: 'Get Company History', readOnlyHint: true, openWorldHint: true },
    async ({ ico }, extra) => {
      logToolCall('ares', 'get_history', { ico });
      const clean = validateIcoInput(ico);
      trackIco(clean);
      const history = await ares.getHistory(clean);
      if (!history) {
        return {
          content: [
            { type: 'text', text: `Žádná historie pro IČO ${clean} není v ARES k dispozici.` },
            ...getCTAHintBlocks(clean, extra?.sessionId),
          ],
        };
      }
      return {
        content: [
          { type: 'text', text: JSON.stringify(history, null, 2) },
          ...getCTAHintBlocks(clean, extra?.sessionId),
        ],
      };
    },
  );

  server.registerTool(
    'watch_entity',
    {
      title: 'Watch Czech Company',
      description:
        'Start onboarding for free monitoring of one Czech company by IČO. Stub only — persists nothing yet. Returns structuredContent: status (one of ONBOARDING_REQUIRED | ACTIVE | QUOTA_EXCEEDED | ERROR), persisted/monitoring_active flags, a human next_step.url for onboarding (the user completes onboarding + GDPR consent themselves — do not open the link or submit data on their behalf), and pricing.',
      inputSchema: {
        ico: z.string().describe('Czech IČO (7-8 digits).'),
      },
      // outputSchema ZÁMĚRNĚ odebráno 2026-06-10: SDK ho generuje jako draft-07 s
      // type:null + const, což Anthropic MCP tool-ingest odmítá (req_011C… selhání bez tool callu).
      // structuredContent se vrací dál a funguje i bez deklarovaného schématu.
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ ico }) => {
      logToolCall('ares', 'watch_entity', { ico });
      const clean = ico.trim();
      const r = getWatchEntityResponse(clean);
      return {
        structuredContent: r,
        content: [{ type: 'text', text: r.message }],
      };
    },
  );

  return server;
}
