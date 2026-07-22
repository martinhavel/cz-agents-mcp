import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { EntitlementStore, HostedEntitlementResolver, accountContextFromToken } from '@czagents/shared/entitlements';
import { buildEuRegistryServer } from '../server.js';
import type { RegistryLookupAuthorizer } from '../server.js';
import type { RegistryAdapter } from '../types.js';

// Regression guard for the fanout CTA-inflation bug found 2026-07-21/22:
// search_company called without a `country` filter fans out across every
// adapter. Each adapter that comes back tier_required used to call
// decision.record?.(false) with no options, and record() emits an
// upgrade_cta event whenever upstreamCalled is false and the error is
// tier_required — so one user query across N blocked countries produced up
// to N upgrade_cta events even though the user only ever sees a single
// response with one combined coverage_preview block. This exercises the
// real HostedEntitlementResolver + EntitlementStore (not a mock) end to end,
// so it proves behavior rather than grepping the source for a call shape.
function stubAdapter(country: string): RegistryAdapter {
  return {
    searchByName: async () => ({ total_results: 0, companies: [] }),
    getById: async () => null,
  };
}

describe('search_company fanout: one query, at most one upgrade_cta', () => {
  let dir: string;
  let store: EntitlementStore;
  let resolver: HostedEntitlementResolver;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'eu-registry-cta-fanout-'));
    store = new EntitlementStore(join(dir, 'tokens.db'));
    store.seedPolicy('test', 'unit');
    resolver = new HostedEntitlementResolver(store, { mode: 'enforce', upgradeUrl: 'https://example.test/upgrade' });
  });

  afterEach(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('N blocked countries in one fanout query yield 1 upgrade_cta but N entitlement_check and N upstream_avoided events', async () => {
    // All five are enabled, Extended-group countries in the seeded policy — every
    // one of them is tier_required for the anonymous Core account below.
    const blockedCountries = ['de', 'fr', 'no', 'dk', 'ee'];
    const adapters = Object.fromEntries(blockedCountries.map((c) => [c, stubAdapter(c)]));
    const account = accountContextFromToken(null, 'free-client', 'test-salt');

    const authorizeLookup: RegistryLookupAuthorizer = ({ country }) => {
      const decision = resolver.check({
        account, country, requestedDepth: 'basic', endpoint: 'mcp:search_company', requestId: 'req-fanout',
      });
      return {
        upstreamAllowed: decision.upstreamAllowed,
        country: decision.country?.toLowerCase(),
        error: decision.error,
        record: (upstreamCalled, options) => resolver.record(decision, upstreamCalled, options),
      };
    };

    const server = buildEuRegistryServer({ adapters, authorizeLookup });
    const client = new Client({ name: 'test', version: '1' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    await client.connect(clientTransport);

    try {
      const result = await client.callTool({ name: 'search_company', arguments: { name: 'acme' } });
      const block = result.content[0];
      if (!block || block.type !== 'text') throw new Error('text content expected');
      const body = JSON.parse(block.text) as { coverage_preview?: unknown[] };
      // Sanity check: every blocked country actually shows up to the user in one response.
      expect(body.coverage_preview).toHaveLength(blockedCountries.length);

      const since = Date.now() - 60_000;
      const report = store.intentReport(since);
      const totals = report.reduce(
        (acc, row) => ({
          entitlementChecks: acc.entitlementChecks + row.requests,
          upgradeCtas: acc.upgradeCtas + row.upgrade_ctas,
          upstreamAvoided: acc.upstreamAvoided + row.upstream_avoided,
        }),
        { entitlementChecks: 0, upgradeCtas: 0, upstreamAvoided: 0 },
      );

      expect(totals.entitlementChecks).toBe(blockedCountries.length);
      expect(totals.upstreamAvoided).toBe(blockedCountries.length);
      expect(totals.upgradeCtas).toBe(1);
    } finally {
      await client.close();
      await server.close();
    }
  });
});
