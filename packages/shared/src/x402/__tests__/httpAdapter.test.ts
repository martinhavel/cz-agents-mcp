import type { IncomingMessage } from 'node:http';
import { describe, expect, it } from 'vitest';
import { NodeHTTPAdapter } from '../httpAdapter.js';

function fakeRequest(overrides: Partial<{
  method: string;
  url: string;
  headers: Record<string, string | string[] | undefined>;
}> = {}): IncomingMessage {
  return {
    method: overrides.method ?? 'POST',
    url: overrides.url ?? '/mcp',
    headers: overrides.headers ?? {},
  } as unknown as IncomingMessage;
}

describe('NodeHTTPAdapter', () => {
  it('getMethod() vrací HTTP metodu, default GET když chybí', () => {
    expect(new NodeHTTPAdapter(fakeRequest({ method: 'PUT' })).getMethod()).toBe('PUT');
    const noMethod = { url: '/mcp', headers: {} } as unknown as IncomingMessage;
    expect(new NodeHTTPAdapter(noMethod).getMethod()).toBe('GET');
  });

  it('getPath() ořízne query string, getUrl() ho ponechá', () => {
    const adapter = new NodeHTTPAdapter(fakeRequest({ url: '/mcp/tool?foo=bar&baz=1' }));
    expect(adapter.getPath()).toBe('/mcp/tool');
    expect(adapter.getUrl()).toBe('/mcp/tool?foo=bar&baz=1');
  });

  it('getPath()/getUrl() bez query stringu vrací stejnou hodnotu', () => {
    const adapter = new NodeHTTPAdapter(fakeRequest({ url: '/mcp' }));
    expect(adapter.getPath()).toBe('/mcp');
    expect(adapter.getUrl()).toBe('/mcp');
  });

  it('getHeader() je case-insensitive a rozbaluje pole na první hodnotu', () => {
    const adapter = new NodeHTTPAdapter(
      fakeRequest({ headers: { 'x-payment': 'abc123', accept: ['application/json', 'text/html'] } }),
    );
    expect(adapter.getHeader('X-Payment')).toBe('abc123');
    expect(adapter.getHeader('x-payment')).toBe('abc123');
    expect(adapter.getHeader('Accept')).toBe('application/json');
  });

  it('getHeader() na chybějící hlavičku vrací undefined', () => {
    const adapter = new NodeHTTPAdapter(fakeRequest());
    expect(adapter.getHeader('x-missing')).toBeUndefined();
  });

  it('getAcceptHeader() má fallback */* a getUserAgent() fallback na prázdný řetězec', () => {
    const adapter = new NodeHTTPAdapter(fakeRequest());
    expect(adapter.getAcceptHeader()).toBe('*/*');
    expect(adapter.getUserAgent()).toBe('');
  });

  it('getAcceptHeader()/getUserAgent() čtou skutečné hlavičky, když jsou přítomné', () => {
    const adapter = new NodeHTTPAdapter(
      fakeRequest({ headers: { accept: 'application/json', 'user-agent': 'x402-test-client/1.0' } }),
    );
    expect(adapter.getAcceptHeader()).toBe('application/json');
    expect(adapter.getUserAgent()).toBe('x402-test-client/1.0');
  });

  it('getBody() vrací undefined, pokud nebylo tělo dodáno, jinak přesně to, co bylo dodáno', () => {
    const withoutBody = new NodeHTTPAdapter(fakeRequest());
    expect(withoutBody.getBody()).toBeUndefined();

    const parsedBody = { x402Version: 2, accepted: { scheme: 'exact' } };
    const withBody = new NodeHTTPAdapter(fakeRequest(), { body: parsedBody });
    expect(withBody.getBody()).toBe(parsedBody);
  });
});
