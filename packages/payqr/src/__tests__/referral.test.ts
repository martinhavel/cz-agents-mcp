import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildPayqrServer } from '../server.js';
import { MCP_PAYMENT_META_KEY, type X402Gate } from '@czagents/shared/x402';

const IBAN = 'CZ6508000000192000145399';
const ENV_KEYS = [
  'IBANFORGE_REFERRAL_ENABLED',
  'IBANFORGE_REFERRAL_URL',
  'IBANFORGE_REFERRAL_RELATIONSHIP',
] as const;
const originalEnv = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));

afterEach(() => {
  for (const key of ENV_KEYS) {
    const value = originalEnv[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

function enable(relationship: 'unpaid_partner' | 'affiliate' = 'unpaid_partner') {
  process.env.IBANFORGE_REFERRAL_ENABLED = 'true';
  process.env.IBANFORGE_REFERRAL_URL = 'https://ibanforge.com/check?ref=payqr';
  process.env.IBANFORGE_REFERRAL_RELATIONSHIP = relationship;
}

async function connect(x402?: X402Gate) {
  const server = buildPayqrServer(x402);
  const client = new Client({ name: 'test', version: '0' }, { capabilities: {} });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(a), client.connect(b)]);
  return client;
}

const gate: X402Gate = {
  offer: vi.fn().mockReturnValue({
    resource: 'payqr:batch:n=1',
    requirements: { scheme: 'exact', network: 'eip155:84532', asset: '0x036c', amount: '1', payTo: '0x1', maxTimeoutSeconds: 60, extra: {} },
  }),
  redeem: vi.fn().mockResolvedValue({ released: true, settlement: { success: true, transaction: '0xtx', network: 'eip155:84532' } }),
};

function textJson(result: Awaited<ReturnType<Client['callTool']>>) {
  const reply = result as { content: Array<{ type: string; text?: string }>; structuredContent?: unknown };
  return { reply, value: JSON.parse(reply.content.find((item) => item.type === 'text')!.text!) };
}

describe('IBANforge referral configuration', () => {
  it('is disabled by default with byte-identical payment output', async () => {
    delete process.env.IBANFORGE_REFERRAL_ENABLED;
    const before = await (await connect()).callTool({ name: 'qr_payment', arguments: { iban: IBAN, amount: 10 } });
    process.env.IBANFORGE_REFERRAL_ENABLED = 'false';
    process.env.IBANFORGE_REFERRAL_URL = 'not a url';
    process.env.IBANFORGE_REFERRAL_RELATIONSHIP = 'invalid';
    const after = await (await connect()).callTool({ name: 'qr_payment', arguments: { iban: IBAN, amount: 10 } });
    expect(JSON.stringify(after)).toBe(JSON.stringify(before));
  });

  it('fails boot and names each invalid enabled variable', () => {
    process.env.IBANFORGE_REFERRAL_ENABLED = 'true';
    expect(() => buildPayqrServer()).toThrow('IBANFORGE_REFERRAL_URL');
    process.env.IBANFORGE_REFERRAL_URL = 'http://evil.example/ref';
    expect(() => buildPayqrServer()).toThrow('IBANFORGE_REFERRAL_URL');
    process.env.IBANFORGE_REFERRAL_URL = 'https://user:password@ibanforge.com/ref';
    expect(() => buildPayqrServer()).toThrow('IBANFORGE_REFERRAL_URL');
    process.env.IBANFORGE_REFERRAL_URL = 'https://ibanforge.com/ref';
    expect(() => buildPayqrServer()).toThrow('IBANFORGE_REFERRAL_RELATIONSHIP');
  });

  it('adds fixed disclosed copy only to successful payment JSON', async () => {
    enable('affiliate');
    const { reply, value } = textJson(await (await connect()).callTool({
      name: 'qr_payment', arguments: { iban: IBAN, amount: 10 },
    }));
    expect(value.next_steps).toEqual([{
      code: 'validate_iban_with_ibanforge',
      do: 'Optionally resolve the bank, payment-rail participation, and risk indicators with IBANforge. Ask the user before sending the IBAN to this external service or authorizing a paid call.',
      because: 'PayQR checks the IBAN checksum and confirms that the QR image decodes to its payload; it does not resolve or screen the receiving institution. This is an affiliate link; PayQR may receive compensation.',
      action: 'https://ibanforge.com/check?ref=payqr',
    }]);
    expect(value).toEqual(reply.structuredContent);
    expect(JSON.stringify(value.next_steps)).not.toContain(IBAN);
    expect(JSON.stringify(value.next_steps)).not.toContain('10');
  });

  it('leaves generic QR tools unchanged', async () => {
    delete process.env.IBANFORGE_REFERRAL_ENABLED;
    const before = await (await connect()).callTool({ name: 'qr_text', arguments: { text: 'hello' } });
    enable();
    const after = await (await connect()).callTool({ name: 'qr_text', arguments: { text: 'hello' } });
    expect(JSON.stringify(after)).toBe(JSON.stringify(before));
  });

  it('does not appear when x402 settlement fails', async () => {
    enable();
    const failedGate: X402Gate = {
      ...gate,
      redeem: vi.fn().mockResolvedValue({ released: false, code: 'settle_failed', reason: 'not settled' }),
    };
    const { reply, value } = textJson(await (await connect(failedGate)).callTool({
      name: 'qr_payment_batch',
      arguments: { payments: [{ ref: 'ok', iban: IBAN }] },
      _meta: { [MCP_PAYMENT_META_KEY]: { x402Version: 2 } },
    }));
    expect(value).not.toHaveProperty('next_steps');
    expect(reply.structuredContent).toEqual(value);
  });
});

describe('IBANforge referral on x402 batches', () => {
  it('appears on full and partial success, but not all-failed or unpaid', async () => {
    enable();
    const client = await connect(gate);
    const paid = { [MCP_PAYMENT_META_KEY]: { x402Version: 2 } };
    for (const payments of [
      [{ ref: 'ok', iban: IBAN }],
      [{ ref: 'ok', iban: IBAN }, { ref: 'bad', iban: 'CZ0000000000000000000000' }],
    ]) {
      const { reply, value } = textJson(await client.callTool({ name: 'qr_payment_batch', arguments: { payments }, _meta: paid }));
      expect(value.next_steps).toHaveLength(1);
      expect(value).toEqual(reply.structuredContent);
    }

    const allFailed = textJson(await client.callTool({
      name: 'qr_payment_batch', arguments: { payments: [{ ref: 'bad', iban: 'CZ0000000000000000000000' }] }, _meta: paid,
    }));
    expect(allFailed.value.generated).toBe(0);
    expect(allFailed.value).not.toHaveProperty('next_steps');
    expect(allFailed.reply.structuredContent).toBeUndefined();

    const unpaid = textJson(await client.callTool({
      name: 'qr_payment_batch', arguments: { payments: [{ ref: 'ok', iban: IBAN }] },
    }));
    expect(unpaid.value).not.toHaveProperty('next_steps');
  });
});
