import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { validateIcoInput } from '@czagents/shared';
import { IsirClient } from './client.js';

export function buildIsirServer(client: IsirClient = new IsirClient()): McpServer {
  // Bind tools below; intentionally stable across stub/real modes.
  const server = new McpServer(
    {
      name: 'cz-agents/isir',
      version: '0.1.0',
    },
    {
      capabilities: { tools: {} },
      instructions:
        'Czech insolvency register (ISIR) lookup. Use whenever the user asks about insolvency, ' +
        'bankruptcy, debt restructuring, or "is this Czech company in trouble?". ' +
        'Note: v0.1.0 is alpha — direct SOAP integration is in progress; current responses may be empty.',
    },
  );

  server.tool(
    'check_ico_insolvency',
    'Check whether a Czech company (by IČO) has any active insolvency proceeding in ISIR. Returns spisová značka, start date, and current phase if found. Returns "no record" if not (which is also informative).',
    {
      ico: z.string().describe('Czech IČO — 7 or 8 digits.'),
    },
    async ({ ico }) => {
      const clean = validateIcoInput(ico);
      try {
        const result = await client.checkActiveInsolvency(clean);
        if (!result) {
          return wrap(`IČO ${clean}: žádné aktivní insolvenční řízení v ISIR (k tomuto okamžiku). Pozn.: v0.1.1 alpha — index podle IČO se buduje, real lookup přijde v 0.2.0.`);
        }
        return wrap(JSON.stringify(result, null, 2));
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        return {
          content: [{ type: 'text', text: `ISIR query failed: ${msg}` }],
          isError: true,
        };
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
    async ({ since_id }) => {
      try {
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
