import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { PayqrClient, type QrResult } from './client.js';

export function buildPayqrServer(): McpServer {
  const server = new McpServer(
    {
      name: 'cz-agents/payqr',
      version: '0.1.3',
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
        'DISPLAYING THE QR: the QR-generating tools return the QR as a PNG image content block. ' +
        'Some MCP clients (notably Claude Desktop) do NOT render tool-result images inline, so the ' +
        'user may see only your text and no picture. To make sure they get a scannable QR, present ' +
        'it on your FIRST response by writing the EXACT base64 PNG bytes THIS tool returned to a ' +
        'downloadable file. CRITICAL: do NOT re-encode or regenerate the QR from the payload string ' +
        'yourself — if you do, you become the source of truth and a single mistyped character would ' +
        'silently send money to the wrong account. If you have no choice but to regenerate the QR ' +
        'instead of reusing the returned bytes, you MUST then call qr_read on your generated image ' +
        'and confirm its decoded payload matches the payload this tool returned, character for ' +
        'character, before showing it. If you cannot produce a file at all, point the user to ' +
        'https://qr.cz-agents.dev.',
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
    async (input) => qrResult(await payqr.payment(input)),
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
function qrResult(value: QrResult) {
  const { qr_data_uri, ...rest } = value;
  const base64 = qr_data_uri.startsWith('data:')
    ? qr_data_uri.slice(qr_data_uri.indexOf(',') + 1)
    : qr_data_uri;
  return {
    content: [
      { type: 'image' as const, data: base64, mimeType: 'image/png' },
      { type: 'text' as const, text: JSON.stringify(rest, null, 2) },
    ],
  };
}
