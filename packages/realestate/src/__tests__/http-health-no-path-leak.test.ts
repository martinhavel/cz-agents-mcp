import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// Regression guard: a security grader flagged /health and /healthz for
// exposing the internal db file path (REALESTATE_DB_PATH, e.g.
// '/data/webapp.db') in the public response body. There's no HTTP harness
// in this package (see packages/dd/src/__tests__/http-entitlement-probe.test.ts
// for the same source-read pattern), so this reads http.ts and asserts the
// /health handler's JSON.stringify payload never references a file path or
// the REALESTATE_DB_PATH env var — only a boolean-ish 'db' status.
describe('GET /health response', () => {
  it('does not include a db_path or filesystem path field', () => {
    const source = readFileSync(new URL('../http.ts', import.meta.url), 'utf8');
    const marker = "req.url === '/health' || req.url === '/healthz'";
    const markerIndex = source.indexOf(marker);
    expect(markerIndex).toBeGreaterThan(-1);

    const handlerEnd = source.indexOf('return;', markerIndex);
    const handler = source.slice(markerIndex, handlerEnd);

    // Only the object literal handed to res.end/JSON.stringify is the public
    // response body — dbAvailable is computed above it from REALESTATE_DB_PATH,
    // which is fine as long as no path or env var name reaches the body itself.
    const bodyStart = handler.indexOf('JSON.stringify({');
    const bodyEnd = handler.indexOf('}));', bodyStart);
    const responseBody = handler.slice(bodyStart, bodyEnd);

    expect(responseBody).not.toMatch(/db_path/);
    expect(responseBody).not.toMatch(/REALESTATE_DB_PATH/);
    expect(responseBody).not.toMatch(/\/data\//);
    expect(responseBody).toMatch(/status:\s*'ok'/);
    expect(responseBody).toMatch(/db:\s*dbAvailable/);
  });
});
