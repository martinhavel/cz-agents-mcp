/**
 * Testy MCP vazby. Kromě chování hlídají i dvě věci ze specifikace, které se
 * dají snadno porušit, aniž by cokoli spadlo:
 *   - `PaymentRequired` musí být v OBOU formátech a musí být shodné
 *   - settlement se vrací v `_meta`, ne v těle
 */
import { describe, expect, it, vi } from 'vitest';
import { withX402Tool, MCP_PAYMENT_META_KEY, MCP_PAYMENT_RESPONSE_META_KEY } from '../mcpBinding.js';
import type { X402Gate } from '../gate.js';

const requirements = {
  scheme: 'exact', network: 'eip155:84532' as const, asset: '0x036c', amount: '5000',
  payTo: '0x1111', maxTimeoutSeconds: 60, extra: {},
};

const gateStub = (over: Partial<X402Gate> = {}): X402Gate => ({
  offer: vi.fn().mockReturnValue({ resource: 'r:1', requirements }),
  redeem: vi.fn().mockResolvedValue({
    released: true, settlement: { success: true, transaction: '0xtx', network: 'eip155:84532' },
  }),
  ...over,
});

const handler = vi.fn().mockResolvedValue({ content: [{ type: 'text', text: 'chráněná data' }] });
const tool = (gate: X402Gate) => withX402Tool(gate, () => 'r:1', handler);

describe('bez platby — signál podle specifikace', () => {
  it('vrací isError a PaymentRequired v OBOU formátech, byte-shodně', async () => {
    const result = await tool(gateStub())({});
    expect(result.isError).toBe(true);
    const fromText = JSON.parse(result.content[0]!.text as string);
    expect(fromText).toEqual(result.structuredContent);
    expect(fromText).toMatchObject({ x402Version: 2, accepts: [requirements] });
  });

  it('nesahá na data, dokud není zaplaceno', async () => {
    handler.mockClear();
    await tool(gateStub())({});
    expect(handler).not.toHaveBeenCalled();
  });

  it('nepoužívá HTTP status — signál je v tool resultu', async () => {
    const result = await tool(gateStub())({});
    expect(result).not.toHaveProperty('status');
    expect(result).not.toHaveProperty('httpStatus');
  });
});

describe('s platbou', () => {
  const paid = { [MCP_PAYMENT_META_KEY]: { x402Version: 2 } };

  it('přečte platbu z extra._meta i z args._meta', async () => {
    const g1 = gateStub();
    await tool(g1)({}, { _meta: paid });
    expect(g1.redeem).toHaveBeenCalled();

    const g2 = gateStub();
    await tool(g2)({ _meta: paid } as never);
    expect(g2.redeem).toHaveBeenCalled();
  });

  it('po úspěchu vydá data a settlement dá do _meta, ne do těla', async () => {
    handler.mockClear();
    const result = await tool(gateStub())({}, { _meta: paid });
    expect(handler).toHaveBeenCalled();
    expect(result._meta?.[MCP_PAYMENT_RESPONSE_META_KEY]).toMatchObject({ transaction: '0xtx' });
    expect(result.content[0]!.text).toBe('chráněná data');
    expect(JSON.stringify(result.content)).not.toContain('0xtx');
  });

  it('neúspěšná platba nevydá data a vrátí novou výzvu', async () => {
    handler.mockClear();
    const gate = gateStub({
      redeem: vi.fn().mockResolvedValue({ released: false, code: 'settle_failed', reason: 'neusadilo se' }),
    });
    const result = await tool(gate)({}, { _meta: paid });
    expect(handler).not.toHaveBeenCalled();
    expect(result.isError).toBe(true);
    expect(JSON.parse(result.content[0]!.text as string)).toMatchObject({ error: 'settle_failed' });
  });
});
