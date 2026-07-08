import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { validateIcoInput, trackIco, trackQuery, personQueryUnitKey, logToolCall, wrapServerTools } from '@czagents/shared';
import { IsirClient } from './client.js';
import { IsirNotConfiguredError } from './cuzk.js';

export function buildIsirServer(client: IsirClient = new IsirClient()): McpServer {
  // Bind tools below; intentionally stable across stub/real modes.
  const server = new McpServer(
    {
      name: 'cz-agents/isir',
      version: '0.2.4',
    },
    {
      capabilities: { tools: {} },
      instructions:
        'Czech insolvency register (ISIR) lookup. Use whenever the user asks about insolvency, ' +
        'bankruptcy, debt restructuring, or "is this Czech company in trouble?". ' +
        'Part of the cz-agents MCP suite — companion servers:\n' +
        '• ares.cz-agents.dev/mcp — Czech Business Register (IČO lookup, VAT, bank accounts)\n' +
        '• dd.cz-agents.dev/mcp — full due diligence (ownership, risk score, statutory chain)\n' +
        '• sanctions.cz-agents.dev/mcp — EU FSF + OFAC sanctions screening\n' +
        'Free tier rate-limited; higher limits at https://cz-agents.dev/pricing.html.',
    },
  );
  wrapServerTools(server);

  server.tool(
    'check_ico_insolvency',
    'Check whether a Czech company (by IČO) has any active insolvency proceeding in ISIR. Returns spisová značka, start date, and current phase if found. Returns "no record" if not (which is also informative).',
    {
      ico: z.string().describe('Czech IČO — 7 or 8 digits.'),
    },
    { title: 'Check IČO Insolvency in ISIR', readOnlyHint: true, openWorldHint: true },
    async ({ ico }) => {
      logToolCall('isir', 'check_ico_insolvency', { ico });
      const clean = validateIcoInput(ico);
      trackIco(clean);
      try {
        const result = await client.checkActiveInsolvency(clean);
        if (!result) {
          return wrap(`IČO ${clean}: žádné aktivní insolvenční řízení v ISIR (k tomuto okamžiku).`);
        }
        return wrap(JSON.stringify(result, null, 2));
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        if (isNotConfigured(e)) return notConfiguredResponse('lookup podle IČO');
        if (isUpstreamUnavailable(msg)) return unavailableResponse('lookup podle IČO');
        return {
          content: [{ type: 'text', text: `ISIR query failed: ${msg}` }],
          isError: true,
        };
      }
    },
  );

  server.tool(
    'search_person_insolvency',
    'Search ISIR for an individual person (FO) by name and optional date of birth. Returns active insolvency proceedings (oddlužení / osobní bankrot). Used to screen statutory persons in KYC and DD workflows.',
    {
      name: z.string().describe('Full name in any case (Czech diacritics tolerated). E.g. "Pavel Novák" or "Jana Svobodová".'),
      dob: z.string().optional().describe('Date of birth, YYYY-MM-DD. Optional but strongly recommended — common names produce many false positives without DOB.'),
      only_active: z.boolean().default(true).describe('When true (default), return only currently active proceedings. False also returns closed/dismissed.'),
    },
    { title: 'Search Person Insolvency in ISIR', readOnlyHint: true, openWorldHint: true },
    async ({ name, dob, only_active }) => {
      try {
        trackQuery(personQueryUnitKey(name, dob));
        logToolCall('isir', 'search_person_insolvency', { name, dob, only_active });
        const matches = await client.searchPersonInsolvency({ name, dob, onlyActive: only_active });
        if (matches.length === 0) {
          return wrap(`Žádné insolvenční řízení pro "${name}"${dob ? ` (nar. ${dob})` : ''} v ISIR.`);
        }
        return wrap(JSON.stringify({ query: { name, dob, only_active }, matches: matches.length, results: matches }, null, 2));
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        if (isNotConfigured(e)) return notConfiguredResponse('vyhledávání osob');
        if (isUpstreamUnavailable(msg)) return unavailableResponse('vyhledávání osob');
        return { content: [{ type: 'text', text: `ISIR person search failed: ${msg}` }], isError: true };
      }
    },
  );

  server.tool(
    'poll_isir_events',
    'Pull a batch of recent ISIR events (insolvency register publications) since the given event id. ISIR is an append-only feed — each call returns up to ~1000 events newer than `since_id`. Use `last_id` from response as next `since_id`. Useful for compliance monitoring or to back-fill an index.',
    {
      since_id: z
        .number()
        .int()
        .min(0)
        .default(0)
        .describe('Last seen event id. Use 0 to start from the beginning of recorded ISIR history (~2008).'),
    },
    { title: 'Poll ISIR Event Feed', readOnlyHint: true, openWorldHint: true },
    async ({ since_id }) => {
      try {
        logToolCall('isir', 'poll_isir_events', { since_id });
        const result = await client.pollEvents(since_id);
        return wrap(JSON.stringify({
          since_id,
          last_id: result.last_id,
          events_returned: result.events.length,
          status: result.status,
          error: result.error_message,
          first_3: result.events.slice(0, 3),
        }, null, 2));
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        return {
          content: [{ type: 'text', text: `ISIR poll failed: ${msg}` }],
          isError: true,
        };
      }
    },
  );

  return server;
}

function wrap(text: string) {
  return { content: [{ type: 'text' as const, text }] };
}

// The by-IČO / by-person ISIR lookup depends on justice.cz IsirWsCuzkService,
// an external SOAP endpoint. When it is unreachable (HTTP 4xx/5xx or a network
// error) we must NEVER imply a clean "no insolvency" result — return an explicit
// "temporarily unavailable, verify manually" so DD callers never read silence as
// a clean screen.
// Stub mode (ISIR_SOAP_ENABLED not set): the lookup never touched live data.
// We must surface this as an explicit "did not run" — NEVER a clean verdict.
function isNotConfigured(e: unknown): boolean {
  return e instanceof IsirNotConfiguredError;
}

function notConfiguredResponse(scope: string) {
  return {
    content: [
      {
        type: 'text' as const,
        text:
          `⚠️ ISIR ${scope}: ISIR není nakonfigurován (chybí ISIR_SOAP_ENABLED), ` +
          `dotaz NEPROBĚHL. POZOR: toto NENÍ výsledek „bez insolvence". ` +
          `Ověř ručně na https://isir.justice.cz/isir/common/index.do.`,
      },
    ],
    isError: true,
  };
}

function isUpstreamUnavailable(msg: string): boolean {
  return /CUZK HTTP \d|HTTP [45]\d\d|ECONN|ENOTFOUND|ETIMEDOUT|EAI_AGAIN|aborted|fetch failed|network|socket hang/i.test(
    msg,
  );
}

function unavailableResponse(scope: string) {
  return {
    content: [
      {
        type: 'text' as const,
        text:
          `⚠️ ISIR ${scope} je dočasně nedostupný — justice.cz webová služba ` +
          `IsirWsCuzkService neodpovídá. POZOR: toto NENÍ výsledek „bez insolvence", ` +
          `dotaz se neprovedl. Ověř ručně na https://isir.justice.cz/isir/common/index.do ` +
          `nebo zkus později.`,
      },
    ],
    isError: true,
  };
}
