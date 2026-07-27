import { afterEach, describe, expect, it, vi } from 'vitest';
import { FacilitatorError, HttpFacilitator } from '../facilitator.js';
import type { PaymentPayload, PaymentRequirements } from '../facilitator.js';

const requirements: PaymentRequirements = {
  scheme: 'exact',
  network: 'eip155:84532',
  asset: '0x036CbD53842c5426634e7929541eC2318f3dCF7e',
  amount: '1000',
  payTo: '0xabc0000000000000000000000000000000000a',
  maxTimeoutSeconds: 60,
  extra: {},
};

const payload: PaymentPayload = {
  x402Version: 2,
  accepted: requirements,
  payload: {
    signature: '0xsig',
    authorization: {
      from: '0xfrom',
      to: requirements.payTo,
      value: '1000',
      validAfter: '0',
      validBefore: '9999999999',
      nonce: '0xnonce',
    },
  },
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('HttpFacilitator — konstrukce', () => {
  it('vyžaduje url', () => {
    expect(() => new HttpFacilitator({ url: '' })).toThrow(/url je povinné/);
  });

  it("authMode 'cdp' bez createAuthHeaders spadne hned při konstrukci", () => {
    expect(() => new HttpFacilitator({ url: 'https://facilitator.test', authMode: 'cdp' })).toThrow(/createAuthHeaders/);
  });
});

describe('HttpFacilitator — úspěšné volání', () => {
  it('supported() zavolá GET /supported a vrátí tělo', async () => {
    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify({ kinds: [{ x402Version: 2, scheme: 'exact', network: 'eip155:84532' }], extensions: [], signers: {} }), { status: 200 }),
    );
    const facilitator = new HttpFacilitator({ url: 'https://facilitator.test/', fetchImpl: fetchMock as unknown as typeof fetch });
    const result = await facilitator.supported();
    expect(result.kinds).toHaveLength(1);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://facilitator.test/supported');
    expect(init.method).toBe('GET');
  });

  it('verify() posílá x402Version + paymentPayload + paymentRequirements na POST /verify', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ isValid: true, payer: '0xfrom' }), { status: 200 }));
    const facilitator = new HttpFacilitator({ url: 'https://facilitator.test', fetchImpl: fetchMock as unknown as typeof fetch });
    const result = await facilitator.verify(payload, requirements);
    expect(result).toMatchObject({ isValid: true, payer: '0xfrom' });
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://facilitator.test/verify');
    expect(init.method).toBe('POST');
    const sentBody = JSON.parse(init.body as string);
    expect(sentBody).toEqual({ x402Version: 2, paymentPayload: payload, paymentRequirements: requirements });
  });

  it('settle() posílá na POST /settle a vrací settlement výsledek', async () => {
    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify({ success: true, transaction: '0xtx', network: 'eip155:84532' }), { status: 200 }),
    );
    const facilitator = new HttpFacilitator({ url: 'https://facilitator.test', fetchImpl: fetchMock as unknown as typeof fetch });
    const result = await facilitator.settle(payload, requirements);
    expect(result).toMatchObject({ success: true, transaction: '0xtx' });
  });

  it("authMode 'cdp' přimíchá hlavičky z createAuthHeaders", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ isValid: true }), { status: 200 }));
    const facilitator = new HttpFacilitator({
      url: 'https://facilitator.test',
      authMode: 'cdp',
      createAuthHeaders: () => ({ 'X-CDP-Auth': 'signed-token' }),
      fetchImpl: fetchMock as unknown as typeof fetch,
    });
    await facilitator.verify(payload, requirements);
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect((init.headers as Record<string, string>)['X-CDP-Auth']).toBe('signed-token');
  });
});

describe('HttpFacilitator — chyby', () => {
  it('HTTP chyba z facilitátoru vyhodí FacilitatorError se jménem fáze', async () => {
    const fetchMock = vi.fn(async () => new Response('invalid signature', { status: 400 }));
    const facilitator = new HttpFacilitator({ url: 'https://facilitator.test', fetchImpl: fetchMock as unknown as typeof fetch });
    await expect(facilitator.verify(payload, requirements)).rejects.toMatchObject({
      name: 'FacilitatorError',
      phase: 'verify',
    });
  });

  it('síťová chyba (fetch reject) vyhodí FacilitatorError', async () => {
    const fetchMock = vi.fn(async () => {
      throw new Error('ECONNREFUSED');
    });
    const facilitator = new HttpFacilitator({ url: 'https://facilitator.test', fetchImpl: fetchMock as unknown as typeof fetch });
    await expect(facilitator.settle(payload, requirements)).rejects.toMatchObject({
      name: 'FacilitatorError',
      phase: 'settle',
    });
  });

  it('timeout (signal se stihne abortovat dřív, než fetch odpoví) vyhodí FacilitatorError', async () => {
    const hangingFetch = vi.fn(
      (_url: string, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => {
            const err = new Error('The operation was aborted');
            err.name = 'AbortError';
            reject(err);
          });
        }),
    );
    const facilitator = new HttpFacilitator({
      url: 'https://facilitator.test',
      timeoutMs: 20,
      fetchImpl: hangingFetch as unknown as typeof fetch,
    });
    await expect(facilitator.supported()).rejects.toMatchObject({
      name: 'FacilitatorError',
      phase: 'supported',
    });
  });

  it('nečitelná JSON odpověď vyhodí FacilitatorError', async () => {
    const fetchMock = vi.fn(async () => new Response('not json{{', { status: 200 }));
    const facilitator = new HttpFacilitator({ url: 'https://facilitator.test', fetchImpl: fetchMock as unknown as typeof fetch });
    await expect(facilitator.supported()).rejects.toBeInstanceOf(FacilitatorError);
  });
});
