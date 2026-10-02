import { afterEach, describe, expect, it, vi } from 'vitest';

type BulkTool = {
  handler: (args: { icos?: string[]; dics?: string[] }) => Promise<{
    isError?: boolean;
    content: Array<{ type: string; text: string }>;
  }>;
};

function bulkTool(server: object): BulkTool {
  return (server as { _registeredTools: Record<string, BulkTool> })
    ._registeredTools.check_bulk_dph_payer!;
}

function fakeClient() {
  return {
    checkBulk: vi.fn().mockResolvedValue({
      service: { generated_on: '2026-08-30', status_code: 0, status_text: 'OK' },
      results: [],
    }),
  };
}

async function serverWithLimit(limit: number) {
  vi.resetModules();
  vi.stubEnv('ADIS_BULK_SIGNATURE_LIMIT', String(limit));
  vi.stubEnv('ADIS_BULK_SIGNATURE_WINDOW_MS', '3600000');
  const [{ buildAdisServer }, requestContext] = await Promise.all([
    import('../server.js'),
    import('@czagents/shared'),
  ]);
  const client = fakeClient();
  return { client, tool: bulkTool(buildAdisServer(client as never)), requestContext };
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe('ADIS bulk signature guard at the server boundary', () => {
  it('limits a normalized UA and canonical DIČ set locally before the sixth upstream call', async () => {
    const { client, tool, requestContext } = await serverWithLimit(5);
    const firstShape = { icos: ['26168685'], dics: ['cz00006947', 'CZ00006947'] };
    const reorderedSet = { dics: ['CZ00006947', 'CZ26168685'] };

    for (let call = 0; call < 5; call += 1) {
      requestContext.setRequestUa(call % 2 === 0 ? ' Test Agent/1.0 ' : 'test   agent/1.0');
      expect((await tool.handler(call % 2 === 0 ? firstShape : reorderedSet)).isError).not.toBe(true);
    }
    expect(client.checkBulk).toHaveBeenCalledTimes(5);

    requestContext.setRequestUa('TEST AGENT/1.0');
    const quotaError = await tool.handler(reorderedSet);
    expect(quotaError.isError).toBe(true);
    expect(quotaError.content[0]?.text).toContain('Bulk ADIS quota exceeded');
    expect(client.checkBulk).toHaveBeenCalledTimes(5);

    requestContext.setRequestUa('different agent/1.0');
    await tool.handler(reorderedSet);
    requestContext.setRequestUa('test agent/1.0');
    await tool.handler({ dics: ['CZ26168685'] });
    expect(client.checkBulk).toHaveBeenCalledTimes(7);
  });

  it('leaves six identical calls enabled by an explicit zero limit', async () => {
    const { client, tool, requestContext } = await serverWithLimit(0);
    requestContext.setRequestUa('test agent/1.0');
    for (let call = 0; call < 6; call += 1) {
      expect((await tool.handler({ dics: ['CZ26168685'] })).isError).not.toBe(true);
    }
    expect(client.checkBulk).toHaveBeenCalledTimes(6);
  });
});
