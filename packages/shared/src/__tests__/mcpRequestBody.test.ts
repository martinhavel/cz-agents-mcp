import { Readable } from 'node:stream';
import { createServer, request as httpRequest } from 'node:http';
import type { IncomingMessage } from 'node:http';
import { describe, expect, it } from 'vitest';
import { McpRequestBodyError, readMcpRequestBody } from '../mcpRequestBody.js';

function request(body: string, headers: Record<string, string> = {}): IncomingMessage {
  const stream = Readable.from([Buffer.from(body)]);
  return Object.assign(stream, { headers }) as IncomingMessage;
}

describe('readMcpRequestBody', () => {
  it('returns the parsed body and counts a valid tools/call request', async () => {
    const body = '{"jsonrpc":"2.0","id":"call-1","method":"tools/call","params":{"name":"lookup","arguments":{"ico":"123"}}}';

    await expect(readMcpRequestBody(request(body))).resolves.toEqual({
      parsedBody: JSON.parse(body),
      toolCallCount: 1,
    });
  });

  it('does not count protocol traffic, notifications, or malformed tool parameters', async () => {
    for (const body of [
      '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}',
      '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}',
      '{"jsonrpc":"2.0","id":1,"method":"ping"}',
      '{"jsonrpc":"2.0","method":"tools/call","params":{"name":"lookup"}}',
      '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"lookup","arguments":"bad"}}',
    ]) {
      await expect(readMcpRequestBody(request(body))).resolves.toMatchObject({ toolCallCount: 0 });
    }
  });

  it('counts each valid tools/call in an SDK-supported batch', async () => {
    const body = '[{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"one"}},{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}},{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"two","arguments":{}}}]';

    await expect(readMcpRequestBody(request(body))).resolves.toMatchObject({ toolCallCount: 2 });
  });

  it('rejects malformed JSON with a 400 caller error', async () => {
    await expect(readMcpRequestBody(request('{not json'))).rejects.toMatchObject({
      status: 400,
      code: 'invalid_json',
    } satisfies Partial<McpRequestBodyError>);
  });

  it('rejects an over-limit streamed body with a 413 caller error', async () => {
    await expect(readMcpRequestBody(request('{"tool":"abcdef"}'), 10)).rejects.toMatchObject({
      status: 413,
      code: 'payload_too_large',
    } satisfies Partial<McpRequestBodyError>);
  });

  it('allows the caller to return 413 for a chunked over-limit request', async () => {
    const server = createServer(async (req, res) => {
      try {
        await readMcpRequestBody(req, 10);
        res.writeHead(204).end();
      } catch (error) {
        expect(error).toMatchObject({ status: 413, closeConnection: true });
        res.writeHead(413, { Connection: 'close' });
        res.end('{"error":"payload_too_large"}');
        res.once('finish', () => req.destroy());
      }
    });

    await new Promise<void>((resolve, reject) => {
      server.listen(0, '127.0.0.1', () => {
        const address = server.address();
        if (!address || typeof address === 'string') return reject(new Error('No TCP address'));
        const client = httpRequest({ hostname: '127.0.0.1', port: address.port, method: 'POST' }, (response) => {
          let responseBody = '';
          response.setEncoding('utf8');
          response.on('data', (chunk) => { responseBody += chunk; });
          response.on('end', () => {
            try {
              expect(response.statusCode).toBe(413);
              expect(responseBody).toContain('payload_too_large');
              server.close((error) => error ? reject(error) : resolve());
            } catch (error) {
              server.close(() => reject(error));
            }
          });
        });
        client.on('error', reject);
        client.write('{"tool":"');
        client.end('abcdef"}');
      });
    });
  });
});
