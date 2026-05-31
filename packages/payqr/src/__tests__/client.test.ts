import { describe, expect, it } from 'vitest';
import {
  PayqrClient,
  buildEpcPayload,
  buildSpaydPayload,
  isValidIban,
  resolveStandard,
} from '../client.js';

const CZ_IBAN = 'CZ6508000000192000145399';
const DE_IBAN = 'DE89370400440532013000';
const TRADING_212 = {
  iban: 'DE70500110800623141382',
  bic: 'CHASDEFX',
  recipient_name: 'Trading 212 Markets Limited',
  amount: 0.07,
  currency: 'EUR',
  variable_symbol: '33562799',
};
const XTB = {
  iban: 'DE66501108014253442321',
  bic: 'CHASDEFX',
  recipient_name: 'XTB S.A',
  amount: 0.07,
  currency: 'EUR',
  variable_symbol: '1583545',
};
const REVOLUT = {
  iban: 'LT983250087356965435',
  bic: 'REVOLT21',
  recipient_name: 'Martin Havel',
  amount: 0.07,
  currency: 'EUR',
};

describe('IBAN validation', () => {
  it('validates the mod-97 checksum', () => {
    expect(isValidIban(CZ_IBAN)).toBe(true);
    expect(isValidIban(DE_IBAN)).toBe(true);
    expect(isValidIban(TRADING_212.iban)).toBe(false);
    expect(isValidIban(XTB.iban)).toBe(true);
    expect(isValidIban(REVOLUT.iban)).toBe(true);
    expect(isValidIban('CZ6508000000192000145398')).toBe(false);
  });
});

describe('payment QR', () => {
  it('builds the SPAYD string and transliterates diacritics', () => {
    expect(buildSpaydPayload({
      iban: CZ_IBAN,
      amount: 1250.5,
      currency: 'CZK',
      message: 'Příliš žluťoučký kůň',
      variable_symbol: '2026001',
    })).toBe(
      'SPD*1.0*ACC:CZ6508000000192000145399*AM:1250.50*CC:CZK*MSG:Prilis zlutoucky kun*X-VS:2026001',
    );
  });

  it('strips the SPAYD delimiter (*) from values so payload cannot be corrupted', () => {
    const payload = buildSpaydPayload({
      iban: CZ_IBAN,
      amount: 100,
      message: 'platba*test*X',
    });
    // '*' removed from MSG → still exactly 5 fields, MSG is the last one intact
    expect(payload).toContain('*MSG:platbatestX');
    expect(payload.split('*MSG:')[1]).not.toContain('*');
  });

  it('rejects an invalid IBAN checksum', () => {
    expect(() => buildSpaydPayload({ iban: 'CZ6508000000192000145398' })).toThrow(/checksum/);
  });

  it('auto-detects CZ IBAN as SPAYD and DE IBAN as EPC', () => {
    expect(resolveStandard('auto', CZ_IBAN)).toBe('spayd');
    expect(resolveStandard('auto', DE_IBAN)).toBe('epc');
  });

  it('builds EPC/GiroCode payload', () => {
    expect(buildEpcPayload({
      iban: DE_IBAN,
      amount: 19.9,
      recipient_name: 'Example GmbH',
      message: 'Invoice 2026-001',
    })).toBe(
      'BCD\n002\n1\nSCT\n\nExample GmbH\nDE89370400440532013000\nEUR19.90\n\n\nInvoice 2026-001\n',
    );
  });

  it('builds EPC fixture payloads with BIC on line 5 and reference on line 11', () => {
    const xtbLines = buildEpcPayload(XTB).split('\n');
    const revolutLines = buildEpcPayload(REVOLUT).split('\n');

    expect(xtbLines).toHaveLength(12);
    expect(xtbLines[4]).toBe('CHASDEFX');
    expect(xtbLines[10]).toBe('1583545');
    expect(revolutLines).toHaveLength(12);
    expect(revolutLines[4]).toBe('REVOLT21');
    expect(revolutLines[10]).toBe('');
  });

  it('rejects the supplied Trading 212 fixture because its IBAN fails mod-97', () => {
    expect(() => buildEpcPayload(TRADING_212)).toThrow(/Invalid IBAN checksum/);
  });

  it('appends variable_symbol to an EPC message and warns', () => {
    const warnings: string[] = [];
    const lines = buildEpcPayload({
      ...XTB,
      message: 'Deposit',
    }, warnings).split('\n');

    expect(lines[10]).toBe('Deposit 1583545');
    expect(warnings).toContain('variable_symbol was appended to EPC remittance');
  });

  it('validates EPC BIC format loosely', () => {
    expect(() => buildEpcPayload({
      ...REVOLUT,
      bic: 'INVALID',
    })).toThrow(/8 or 11 alphanumeric/);
  });

  it('enforces strict EPC EUR currency', () => {
    expect(() => buildEpcPayload({
      iban: DE_IBAN,
      currency: 'CZK',
      recipient_name: 'Example GmbH',
    })).toThrow(/EUR only/);
  });

  it('enforces strict EPC 140-character remittance maximum', () => {
    expect(() => buildEpcPayload({
      iban: DE_IBAN,
      recipient_name: 'Example GmbH',
      message: 'x'.repeat(141),
    })).toThrow(/140/);
  });

  it('requires EPC recipient name', () => {
    expect(() => buildEpcPayload({ iban: DE_IBAN })).toThrow(/recipient_name/);
  });
});

describe('PayqrClient', () => {
  const client = new PayqrClient();

  it('qr_payment returns a PNG data URI and selected standard', async () => {
    const result = await client.payment({ iban: CZ_IBAN, amount: 10 });
    expect(result.standard).toBe('spayd');
    expect(result.qr_data_uri).toMatch(/^data:image\/png;base64,/);
  });

  it('qr_text creates a plain text QR', async () => {
    const result = await client.text('https://cz-agents.dev');
    expect(result.payload).toBe('https://cz-agents.dev');
    expect(result.qr_data_uri).toMatch(/^data:image\/png;base64,/);
  });

  it('qr_wifi creates WIFI payload', async () => {
    const result = await client.wifi({ ssid: 'Office;Guest', password: 'secret', hidden: true });
    expect(result.payload).toBe('WIFI:T:WPA;S:Office\\;Guest;P:secret;H:true;;');
  });

  it('qr_vcard creates vCard 3.0 payload', async () => {
    const result = await client.vcard({ name: 'Ada Example', email: 'ada@example.test' });
    expect(result.payload).toBe(
      'BEGIN:VCARD\r\nVERSION:3.0\r\nFN:Ada Example\r\nEMAIL:ada@example.test\r\nEND:VCARD',
    );
  });

  it('qr_read decodes and parses a SPAYD QR round trip', async () => {
    const generated = await client.payment({
      iban: CZ_IBAN,
      amount: 42.25,
      message: 'Invoice 42',
      variable_symbol: '42',
    });
    const result = await client.read(generated.qr_data_uri);
    expect(result.type).toBe('payment/SPAYD');
    expect(result.parsed).toMatchObject({
      iban: CZ_IBAN,
      amount: 42.25,
      currency: 'CZK',
      vs: '42',
      message: 'Invoice 42',
    });
  });

  it('qr_read classifies EPC payment payload', async () => {
    const generated = await client.payment({
      iban: DE_IBAN,
      amount: 9.99,
      recipient_name: 'Example GmbH',
      message: 'Invoice 9',
    });
    const result = await client.read(generated.qr_data_uri);
    expect(result.type).toBe('payment/EPC');
    expect(result.parsed).toMatchObject({
      iban: DE_IBAN,
      amount: 9.99,
      currency: 'EUR',
      message: 'Invoice 9',
    });
  });

  it('qr_read recovers the XTB EPC fixture reference', async () => {
    const generated = await client.payment(XTB);
    const result = await client.read(generated.qr_data_uri);
    expect(result.type).toBe('payment/EPC');
    expect(result.parsed).toMatchObject({
      iban: XTB.iban,
      bic: XTB.bic,
      amount: XTB.amount,
      currency: 'EUR',
      message: XTB.variable_symbol,
    });
  });
});
