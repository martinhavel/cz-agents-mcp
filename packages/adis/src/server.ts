import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { validateIcoInput } from '@czagents/shared';
import { AdisClient, MAX_DIC_PER_REQUEST } from './client.js';

export function buildAdisServer(client: AdisClient = new AdisClient()): McpServer {
  const server = new McpServer(
    {
      name: 'cz-agents/adis',
      version: '0.1.0',
    },
    {
      capabilities: { tools: {} },
      instructions:
        'Czech VAT-payer reliability check (nespolehlivý plátce DPH). Use whenever the user ' +
        'asks about VAT status, transparent bank accounts (§ 96a ZDPH), or "is this company a ' +
        'reliable VAT payer?". Backed by the official MFČR ADIS SOAP service. Status meanings: ' +
        'NE = reliable (good), ANO = unreliable (red flag, must use a published account to avoid ' +
        'joint-liability under § 109 ZDPH), NENALEZEN = subject is not in the VAT registry.',
    },
  );

  server.tool(
    'check_dph_payer',
    'Check VAT-payer reliability for a single Czech subject. Returns reliability status ' +
      '(ANO/NE/NENALEZEN), subject type (VAT payer / identified person / VAT group / unreliable ' +
      'person / not found), name, address, published bank accounts (§ 96a ZDPH), and the date ' +
      'the subject became unreliable (when applicable). Returns null when the DIČ is not in the ' +
      'VAT registry.',
    {
      ico: z.string().optional().describe('Czech IČO — 7 or 8 digits. The client converts to DIČ as "CZ${ico}". Provide either ico or dic.'),
      dic: z.string().optional().describe('Czech DIČ, e.g. "CZ27074358". Provide either ico or dic.'),
    },
    { title: 'Check Czech VAT Payer Reliability', readOnlyHint: true, openWorldHint: true },
    async ({ ico, dic }) => {
      try {
        if (!ico && !dic) {
          return error('Either `ico` or `dic` is required.');
        }
        const cleanIco = ico ? validateIcoInput(ico) : undefined;
        const result = await client.checkPayer({ ico: cleanIco, dic });
        if (!result) {
          const subject = dic ?? `CZ${cleanIco}`;
          return wrap(`DIČ ${subject}: není v registru plátců DPH (NENALEZEN). Subjekt buď není plátce DPH, nebo nikdy nebyl registrován.`);
        }
        return wrap(JSON.stringify(result, null, 2));
      } catch (e) {
        return error(e);
      }
    },
  );

  server.tool(
    'check_bulk_dph_payer',
    `Bulk reliability check for up to ${MAX_DIC_PER_REQUEST} Czech subjects in one ADIS request. ` +
      'Lighter than the single-subject check — returns reliability status, accounts, and tax ' +
      'office, but no name/address. Useful for screening invoice-issuer lists or supplier ' +
      'portfolios. Returns one entry per input DIČ; entries with reliability NENALEZEN ' +
      'indicate the subject is not in the VAT registry.',
    {
      icos: z.array(z.string()).optional().describe('List of Czech IČOs. Will be converted to DIČ ("CZ${ico}").'),
      dics: z.array(z.string()).optional().describe('List of Czech DIČs (e.g. ["CZ27074358", "CZ12345678"]). At least one of icos/dics is required.'),
    },
    { title: 'Bulk Check Czech VAT Payer Reliability', readOnlyHint: true, openWorldHint: true },
    async ({ icos, dics }) => {
      try {
        if ((!icos || icos.length === 0) && (!dics || dics.length === 0)) {
          return error('Provide at least one IČO or DIČ.');
        }
        const cleanIcos = icos?.map((ico) => validateIcoInput(ico));
        const result = await client.checkBulk({ icos: cleanIcos, dics });
        return wrap(JSON.stringify(result, null, 2));
      } catch (e) {
        return error(e);
      }
    },
  );

  server.tool(
    'list_unreliable_payers',
    'Return the full list of currently unreliable Czech VAT payers from ADIS. WARNING: response ' +
      'can be 50–100 MB (tens of thousands of entries). Intended for daily mirroring into a local ' +
      'database, not for ad-hoc inspection. For "is this specific company unreliable?" use ' +
      'check_dph_payer instead.',
    {},
    { title: 'List All Unreliable VAT Payers', readOnlyHint: true, openWorldHint: true },
    async () => {
      try {
        const result = await client.listUnreliable();
        return wrap(JSON.stringify({
          generated_on: result.service.generated_on,
          status: result.service.status_text,
          count: result.unreliable.length,
          first_20: result.unreliable.slice(0, 20),
          note: 'Truncated to first 20 entries for chat-friendly display. Call this tool from a script and inspect `unreliable` for the full list.',
        }, null, 2));
      } catch (e) {
        return error(e);
      }
    },
  );

  return server;
}

function wrap(text: string) {
  return { content: [{ type: 'text' as const, text }] };
}

function error(e: unknown) {
  const msg = e instanceof Error ? e.message : String(e);
  return { content: [{ type: 'text' as const, text: `ADIS query failed: ${msg}` }], isError: true };
}
