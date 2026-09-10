import type { IncomingMessage } from 'node:http';

export class McpRequestBodyError extends Error {
  /** True when the caller must close the connection after sending this error response. */
  public readonly closeConnection: boolean;

  constructor(
    public readonly status: 400 | 413,
    public readonly code: 'invalid_json' | 'payload_too_large',
  ) {
    super(code === 'payload_too_large' ? 'Request body is too large.' : 'Request body must be valid JSON.');
    this.name = 'McpRequestBodyError';
    this.closeConnection = status === 413;
  }
}

export interface McpRequestBody {
  parsedBody: unknown;
  toolCallCount: number;
  toolCallIds: Array<string | number>;
}

/**
 * Reads an MCP POST body once so middleware can inspect it before passing the
 * same parsed value to StreamableHTTPServerTransport.handleRequest().
 *
 * A 413 leaves the request stream intact so the caller can send its response.
 * The caller must send `Connection: close` and destroy the request after the
 * response finishes, rather than reusing a connection with an unread body.
 */
export async function readMcpRequestBody(
  req: IncomingMessage,
  maxBytes = 100_000,
): Promise<McpRequestBody> {
  const declaredLength = req.headers['content-length'];
  if (typeof declaredLength === 'string' && Number(declaredLength) > maxBytes) {
    throw new McpRequestBodyError(413, 'payload_too_large');
  }

  const chunks: Buffer[] = [];
  let size = 0;

  try {
    for await (const chunk of req.iterator({ destroyOnReturn: false })) {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      size += bytes.length;
      if (size > maxBytes) {
        throw new McpRequestBodyError(413, 'payload_too_large');
      }
      chunks.push(bytes);
    }
  } catch (error) {
    if (error instanceof McpRequestBodyError) throw error;
    throw new McpRequestBodyError(400, 'invalid_json');
  }

  let parsedBody: unknown;
  try {
    parsedBody = JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
  } catch {
    throw new McpRequestBodyError(400, 'invalid_json');
  }

  const toolCalls = (Array.isArray(parsedBody) ? parsedBody : [parsedBody]).filter(isToolCall);
  return { parsedBody, toolCallCount: toolCalls.length,
    toolCallIds: toolCalls.map((call) => (call as Record<string, unknown>).id as string | number) };
}

function isToolCall(value: unknown): boolean {
  if (!isRecord(value) || value.jsonrpc !== '2.0' || !Object.hasOwn(value, 'id')) return false;
  if (!Object.keys(value).every((key) => key === 'jsonrpc' || key === 'id' || key === 'method' || key === 'params')) return false;
  if (!isRequestId(value.id) || value.method !== 'tools/call' || !isRecord(value.params)) return false;
  if (typeof value.params.name !== 'string') return false;
  return !Object.hasOwn(value.params, 'arguments') || isRecord(value.params.arguments);
}

function isRequestId(value: unknown): value is string | number {
  return typeof value === 'string' || (typeof value === 'number' && Number.isInteger(value));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
