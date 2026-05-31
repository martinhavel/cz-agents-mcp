import { Jimp } from 'jimp';
import jsQrModule from 'jsqr';
import QRCode from 'qrcode';

type JsQr = (
  data: Uint8ClampedArray,
  width: number,
  height: number,
) => { data: string } | null;

const jsQR = (typeof jsQrModule === 'function' ? jsQrModule : jsQrModule.default) as JsQr;

export type PaymentStandard = 'spayd' | 'epc' | 'auto';

export interface PaymentInput {
  iban: string;
  bic?: string;
  amount?: number;
  currency?: string;
  message?: string;
  variable_symbol?: string;
  constant_symbol?: string;
  recipient_name?: string;
  standard?: PaymentStandard;
}

export interface QrResult {
  qr_data_uri: string;
  payload: string;
}

export interface PaymentQrResult extends QrResult {
  standard: 'spayd' | 'epc';
  warnings: string[];
}

export interface ReadQrResult {
  raw: string;
  type: string;
  parsed: Record<string, unknown> | null;
}

const SEPA_COUNTRIES = new Set([
  'AD', 'AT', 'BE', 'BG', 'CH', 'CY', 'CZ', 'DE', 'DK', 'EE', 'ES', 'FI', 'FR', 'GB',
  'GI', 'GR', 'HR', 'HU', 'IE', 'IS', 'IT', 'LI', 'LT', 'LU', 'LV', 'MC', 'MT', 'NL',
  'NO', 'PL', 'PT', 'RO', 'SE', 'SI', 'SK', 'SM', 'VA',
]);

export class PayqrClient {
  async payment(input: PaymentInput): Promise<PaymentQrResult> {
    const iban = normalizeIban(input.iban);
    if (!isValidIban(iban)) throw new Error('Invalid IBAN checksum');

    const standard = resolveStandard(input.standard ?? 'auto', iban);
    const warnings: string[] = [];
    let payload: string;

    if (standard === 'spayd') {
      payload = buildSpaydPayload({ ...input, iban }, warnings);
    } else {
      payload = buildEpcPayload({ ...input, iban }, warnings);
    }

    return { qr_data_uri: await renderQr(payload), payload, standard, warnings };
  }

  async text(text: string): Promise<QrResult> {
    return { qr_data_uri: await renderQr(text), payload: text };
  }

  async wifi(input: {
    ssid: string;
    password?: string;
    security?: 'WPA' | 'WEP' | 'nopass';
    hidden?: boolean;
  }): Promise<QrResult> {
    const security = input.security ?? 'WPA';
    const payload =
      `WIFI:T:${security};S:${escapeWifi(input.ssid)};` +
      `${input.password === undefined ? '' : `P:${escapeWifi(input.password)};`}` +
      `${input.hidden ? 'H:true;' : ''};`;
    return { qr_data_uri: await renderQr(payload), payload };
  }

  async vcard(input: {
    name: string;
    phone?: string;
    email?: string;
    org?: string;
  }): Promise<QrResult> {
    const fields = ['BEGIN:VCARD', 'VERSION:3.0', `FN:${escapeVcard(input.name)}`];
    if (input.phone) fields.push(`TEL:${escapeVcard(input.phone)}`);
    if (input.email) fields.push(`EMAIL:${escapeVcard(input.email)}`);
    if (input.org) fields.push(`ORG:${escapeVcard(input.org)}`);
    fields.push('END:VCARD');
    const payload = fields.join('\r\n');
    return { qr_data_uri: await renderQr(payload), payload };
  }

  async read(imageData: string): Promise<ReadQrResult> {
    const image = await Jimp.read(decodeImageData(imageData));
    const { data, width, height } = image.bitmap;
    const decoded = jsQR(new Uint8ClampedArray(data), width, height);
    if (!decoded) throw new Error('No QR code found in image');
    return classifyQr(decoded.data);
  }
}

export function normalizeIban(iban: string): string {
  return iban.replace(/\s+/g, '').toUpperCase();
}

export function isValidIban(iban: string): boolean {
  const compact = normalizeIban(iban);
  if (!/^[A-Z]{2}\d{2}[A-Z0-9]{10,30}$/.test(compact)) return false;
  const rearranged = compact.slice(4) + compact.slice(0, 4);
  let remainder = 0;
  for (const char of rearranged) {
    const value = char >= 'A' && char <= 'Z' ? String(char.charCodeAt(0) - 55) : char;
    for (const digit of value) remainder = (remainder * 10 + Number(digit)) % 97;
  }
  return remainder === 1;
}

export function resolveStandard(standard: PaymentStandard, iban: string): 'spayd' | 'epc' {
  if (standard !== 'auto') return standard;
  const country = normalizeIban(iban).slice(0, 2);
  if (country === 'CZ' || country === 'SK') return 'spayd';
  if (!SEPA_COUNTRIES.has(country)) throw new Error(`IBAN country ${country} is not in SEPA`);
  return 'epc';
}

export function buildSpaydPayload(input: PaymentInput, warnings: string[] = []): string {
  const iban = normalizeIban(input.iban);
  if (!isValidIban(iban)) throw new Error('Invalid IBAN checksum');
  const fields = ['SPD*1.0', `ACC:${iban}`];
  if (input.amount !== undefined) fields.push(`AM:${formatAmount(input.amount)}`);
  fields.push(`CC:${(input.currency ?? 'CZK').toUpperCase()}`);
  if (input.message) fields.push(`MSG:${toSpaydAscii(input.message)}`);
  if (input.variable_symbol) fields.push(`X-VS:${toSpaydAscii(input.variable_symbol)}`);
  if (input.constant_symbol) fields.push(`X-KS:${toSpaydAscii(input.constant_symbol)}`);
  if (input.bic) warnings.push('bic is not encoded by SPAYD');
  if (input.recipient_name) warnings.push('recipient_name is not encoded by SPAYD');
  return fields.join('*');
}

export function buildEpcPayload(input: PaymentInput, warnings: string[] = []): string {
  const iban = normalizeIban(input.iban);
  if (!isValidIban(iban)) throw new Error('Invalid IBAN checksum');
  const country = iban.slice(0, 2);
  if (!SEPA_COUNTRIES.has(country)) throw new Error(`IBAN country ${country} is not in SEPA`);
  const currency = (input.currency ?? 'EUR').toUpperCase();
  if (currency !== 'EUR') throw new Error('EPC payment QR supports EUR only');
  if (!input.recipient_name) throw new Error('EPC payment QR requires recipient_name');
  const bic = input.bic ?? '';
  if (bic && !/^[A-Za-z0-9]{8}(?:[A-Za-z0-9]{3})?$/.test(bic)) {
    throw new Error('EPC BIC must be 8 or 11 alphanumeric characters');
  }
  const remittance = [input.message, input.variable_symbol].filter(Boolean).join(' ');
  if (remittance.length > 140) throw new Error('EPC remittance must not exceed 140 characters');
  if (input.message && input.variable_symbol) warnings.push('variable_symbol was appended to EPC remittance');
  if (input.constant_symbol) warnings.push('constant_symbol is not encoded by EPC');
  const amount = input.amount === undefined ? '' : `EUR${formatAmount(input.amount)}`;
  return ['BCD', '002', '1', 'SCT', bic, input.recipient_name, iban, amount, '', '', remittance, ''].join('\n');
}

export function classifyQr(raw: string): ReadQrResult {
  if (raw.startsWith('SPD*')) return { raw, type: 'payment/SPAYD', parsed: parseSpayd(raw) };
  if (raw.startsWith('BCD\n')) return { raw, type: 'payment/EPC', parsed: parseEpc(raw) };
  if (/^https?:\/\//i.test(raw)) return { raw, type: 'url', parsed: null };
  if (raw.startsWith('WIFI:')) return { raw, type: 'wifi', parsed: null };
  if (raw.startsWith('BEGIN:VCARD')) return { raw, type: 'vcard', parsed: null };
  return { raw, type: 'text', parsed: null };
}

function parseSpayd(raw: string): Record<string, unknown> {
  const fields = Object.fromEntries(raw.split('*').slice(1).map((field) => {
    const separator = field.indexOf(':');
    return [field.slice(0, separator), field.slice(separator + 1)];
  }));
  return {
    iban: fields.ACC,
    amount: fields.AM === undefined ? undefined : Number(fields.AM),
    currency: fields.CC,
    vs: fields['X-VS'],
    message: fields.MSG,
  };
}

function parseEpc(raw: string): Record<string, unknown> {
  const lines = raw.split('\n');
  const amount = lines[7]?.startsWith('EUR') ? Number(lines[7].slice(3)) : undefined;
  return {
    iban: lines[6],
    bic: lines[4] || undefined,
    amount,
    currency: 'EUR',
    message: lines[10] || undefined,
  };
}

async function renderQr(payload: string): Promise<string> {
  return QRCode.toDataURL(payload, { type: 'image/png', errorCorrectionLevel: 'M' });
}

function decodeImageData(imageData: string): Buffer {
  const base64 = imageData.startsWith('data:') ? imageData.slice(imageData.indexOf(',') + 1) : imageData;
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(base64)) throw new Error('image_data must be base64 or a data URI');
  return Buffer.from(base64, 'base64');
}

function formatAmount(amount: number): string {
  if (!Number.isFinite(amount) || amount < 0) throw new Error('Amount must be a non-negative finite number');
  return amount.toFixed(2);
}

function toSpaydAscii(value: string): string {
  // Strip diacritics \u2192 ASCII, then remove '*' \u2014 it is the SPAYD field delimiter,
  // so an unescaped '*' inside a value (message/VS) would corrupt the payload and
  // produce an unscannable / wrong QR. SPAYD has no escaping, so removal is the
  // safe choice.
  return value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^\x20-\x7E]/g, '')
    .replace(/\*/g, '');
}

function escapeWifi(value: string): string {
  return value.replace(/([\\;,":])/g, '\\$1');
}

function escapeVcard(value: string): string {
  return value.replace(/([\\;,])/g, '\\$1').replace(/\r?\n/g, '\\n');
}
