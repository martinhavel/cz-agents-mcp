import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { PayqrClient, type QrResult, type PaymentInput } from './client.js';
import { putQr, putPrefill } from './qr-store.js';

// Set only on the hosted HTTP server (compose env). When present, generated QRs are
// exposed as short temporary URLs the client can render inline; absent (npx/stdio) we
// fall back to base64 in the result.
const PUBLIC_BASE_URL = process.env.PUBLIC_BASE_URL;

// Public web app — opens with the payment prefilled and the QR already rendered.
// Works in any browser, independent of the hosted server (good fallback when a client
// cannot render images inline, e.g. Claude Desktop).
const WEB_APP_URL = process.env.WEB_APP_URL ?? 'https://qr.cz-agents.dev';

// Opaque web link: payment fields are stashed server-side under a random id (ephemeral)
// and the URL carries ONLY ?p=<id> — no payment data in the URL, so nothing leaks into
// browser history / logs / referrers and the link cannot be hand-crafted or tampered.
// Requires the hosted server (the /p/<id> endpoint); returns undefined for npx/stdio.
function buildWebUrl(input: PaymentInput): string | undefined {
  if (!PUBLIC_BASE_URL) return undefined;
  const fields: Record<string, string> = {};
  if (input.iban) fields.iban = input.iban;
  if (input.amount !== undefined) fields.amount = String(input.amount);
  if (input.currency) fields.currency = input.currency;
  if (input.recipient_name) fields.recipient = input.recipient_name;
  if (input.bic) fields.bic = input.bic;
  if (input.variable_symbol) fields.vs = input.variable_symbol;
  if (input.constant_symbol) fields.ks = input.constant_symbol;
  if (input.message) fields.msg = input.message;
  const id = putPrefill(JSON.stringify(fields));
  return `${WEB_APP_URL}/?p=${id}`;
}

export function buildPayqrServer(): McpServer {
  const server = new McpServer(
    {
      name: 'cz-agents/payqr',
      version: '0.1.9',
    },
    {
      capabilities: { tools: {} },
      instructions:
        'European Payment QR generator and QR utility tools. Deterministically create SPAYD ' +
        '(CZ/SK) or EPC/GiroCode (SEPA) payment QR codes, plain-text QR codes, Wi-Fi QR codes, ' +
        'vCards, and decode QR images. Free MIT-licensed tool with no AI and no paid API.\n\n' +
        'PAYMENT-FROM-IMAGE / INVOICE WORKFLOW: When the user shares a PDF, photo or screenshot ' +
        'of payment details — most commonly an INVOICE (Czech "faktura") that has no QR code, but ' +
        'also a broker deposit instruction (Revolut, Trading 212, XTB), a bank transfer slip or a ' +
        'paper bill — read the IBAN, amount, currency, recipient name and reference / variable ' +
        'symbol from the document yourself, then call qr_payment with those values. This is the ' +
        'primary use case: it turns an invoice or payment instruction that lacks a QR code into a ' +
        'scannable payment QR, removing the error-prone manual re-typing into a banking app.\n' +
        'MANDATORY before showing the QR: echo the extracted fields back to the user as a short ' +
        'confirmation list (IBAN, amount, currency, recipient, reference) and ask them to verify ' +
        'against the source, because a misread digit sends real money to the wrong place. After the ' +
        'user confirms, present the QR. You may also call qr_read on the generated QR to show ' +
        'exactly what it encodes as a second check. Never silently generate a payment QR from an ' +
        'image without this read-back confirmation step.\n' +
        'DISPLAYING THE QR: the result has "self_verified" (the server re-decoded its own PNG and ' +
        'confirmed it matches "payload" — trust it; do NOT call qr_read on your own output). On the ' +
        'hosted server the result also has "qr_url": a short, TEMPORARY (~15 min) hosted PNG. ' +
        'TO SHOW THE QR, present qr_url — render it inline as an image, e.g. ![payment QR](qr_url), ' +
        'or give it as a link. A URL cannot be corrupted and clients render it natively. Do NOT ' +
        'transcribe base64, do NOT regenerate the QR, do NOT build your own PNG. (If there is no ' +
        'qr_url — e.g. self-hosted via npx — decode qr_png_base64 programmatically, never by hand; ' +
        'if you cannot, send the user to https://qr.cz-agents.dev.)\n' +
        'qr_read is ONLY for QR codes you did NOT generate here (an existing invoice QR the user ' +
        'provides), where the server cannot know the expected payload. SAFE-FAIL there: if qr_read ' +
        'errors or you cannot trust the decode, do not present it as a verified payment and do not ' +
        'rationalize — point the user to https://qr.cz-agents.dev. One wrong character sends money ' +
        'to the wrong account.',
    },
  );

  const payqr = new PayqrClient();

  server.tool(
    'qr_payment',
    'Create a European payment QR code. Auto-selects SPAYD for CZ/SK IBANs and EPC/GiroCode for other SEPA IBANs.',
    {
      iban: z.string().describe('Recipient IBAN. Validated with the IBAN mod-97 checksum.'),
      bic: z.string().optional().describe('Optional BIC for EPC/GiroCode line 5. Ignored with a warning for SPAYD.'),
      amount: z.number().optional().describe('Optional payment amount.'),
      currency: z.string().optional().describe('Optional ISO 4217 currency code. Defaults to CZK for SPAYD and EUR for EPC.'),
      message: z.string().optional().describe('Optional payment message or EPC remittance text.'),
      variable_symbol: z.string().optional().describe('Optional reference: goes to remittance (line 11) for EPC, to X-VS for SPAYD.'),
      constant_symbol: z.string().optional().describe('Optional Czech constant symbol for SPAYD.'),
      recipient_name: z.string().optional().describe('Recipient name. Required for EPC/GiroCode.'),
      standard: z.enum(['spayd', 'epc', 'auto']).default('auto').describe('Payment QR standard. Defaults to auto detection.'),
    },
    { title: 'Create Payment QR', readOnlyHint: true, openWorldHint: false },
    async (input) => {
      const web_url = buildWebUrl(input);
      return qrResult(await payqr.payment(input), web_url ? { web_url } : undefined);
    },
  );

  server.tool(
    'qr_text',
    'Create a QR code containing plain text.',
    {
      text: z.string().describe('Text to encode in the QR code.'),
    },
    { title: 'Create Text QR', readOnlyHint: true, openWorldHint: false },
    async ({ text }) => qrResult(await payqr.text(text)),
  );

  server.tool(
    'qr_wifi',
    'Create a Wi-Fi network QR code.',
    {
      ssid: z.string().describe('Wi-Fi network name.'),
      password: z.string().optional().describe('Optional Wi-Fi password.'),
      security: z.enum(['WPA', 'WEP', 'nopass']).default('WPA').describe('Wi-Fi security type.'),
      hidden: z.boolean().default(false).describe('Whether the network SSID is hidden.'),
    },
    { title: 'Create Wi-Fi QR', readOnlyHint: true, openWorldHint: false },
    async (input) => qrResult(await payqr.wifi(input)),
  );

  server.tool(
    'qr_vcard',
    'Create a QR code containing a vCard 3.0 contact.',
    {
      name: z.string().describe('Contact display name.'),
      phone: z.string().optional().describe('Optional phone number.'),
      email: z.string().optional().describe('Optional email address.'),
      org: z.string().optional().describe('Optional organization.'),
    },
    { title: 'Create vCard QR', readOnlyHint: true, openWorldHint: false },
    async (input) => qrResult(await payqr.vcard(input)),
  );

  server.tool(
    'qr_read',
    'Decode a QR code from a base64 PNG/JPEG image or image data URI and classify its content.',
    {
      image_data: z.string().describe('Base64 image bytes or a PNG/JPEG data URI.'),
    },
    { title: 'Read QR Image', readOnlyHint: true, openWorldHint: false },
    async ({ image_data }) => jsonResult(await payqr.read(image_data)),
  );

  return server;
}

function jsonResult(value: unknown) {
  return {
    content: [{ type: 'text' as const, text: JSON.stringify(value, null, 2) }],
  };
}

// QR-generating tools return BOTH an MCP image block (so Claude Desktop / clients
// render the QR natively as a picture — not a broken base64 string the model tries
// to "display" itself) AND a text block with payload/standard/warnings for context.
function qrResult(value: QrResult, extra?: Record<string, unknown>) {
  const { qr_data_uri, ...rest } = value;
  const base64 = qr_data_uri.startsWith('data:')
    ? qr_data_uri.slice(qr_data_uri.indexOf(',') + 1)
    : qr_data_uri;
  const text: Record<string, unknown> = { ...rest, ...(extra ?? {}) };
  const webHint = text.web_url
    ? ' For a guaranteed view (e.g. Claude Desktop, which may not render inline images), give web_url — ' +
      'it opens the payment in the browser app with the QR already rendered. It carries no payment data ' +
      '(opaque id), only renders.'
    : '';
  if (PUBLIC_BASE_URL) {
    // Hosted server: stash the PNG and hand the model a short, un-corruptible URL the
    // client renders inline. Ephemeral — 15-min TTL, in-memory only, never persisted.
    const id = putQr(Buffer.from(base64, 'base64'));
    text.qr_url = `${PUBLIC_BASE_URL}/i/${id}.png`;
    text.display_hint =
      'self_verified = the server confirmed this PNG decodes to payload. To SHOW the QR, present ' +
      'qr_url as an inline image, e.g. ![payment QR](qr_url).' + webHint +
      ' Do NOT transcribe base64, regenerate the QR, or call qr_read on your own output.';
  } else {
    // npx / self-hosted (no public endpoint): expose base64 for programmatic decode.
    text.qr_png_base64 = base64;
    text.display_hint =
      'self_verified = the server confirmed this PNG decodes to payload. To SHOW the QR, decode ' +
      'qr_png_base64 PROGRAMMATICALLY (never hand-retype ~2KB) and write a .png; if you cannot ' +
      'render it, send the user to https://qr.cz-agents.dev. Do NOT call qr_read on your own output.';
  }
  return {
    content: [
      { type: 'image' as const, data: base64, mimeType: 'image/png' },
      { type: 'text' as const, text: JSON.stringify(text, null, 2) },
    ],
  };
}
