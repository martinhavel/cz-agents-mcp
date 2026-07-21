import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// Regression guard for a production artifact found 2026-07-21: the REST
// entitlement self-check endpoint (`rest:entitlement_check`) called
// entitlementResolver.record(decision, false) unconditionally, before any
// upstreamAllowed check. record() emits an `upgrade_cta` event whenever
// upstreamCalled is false and the decision is tier_required — so every probe
// against this endpoint silently inflated the upgrade_cta counter. Verified on
// prod: all 4 existing upgrade_cta events came from this endpoint, none from a
// real user. http.ts isn't otherwise unit-tested (no HTTP harness in this
// package, see server-pricing-url.test.ts for the same source-read pattern),
// so this asserts the fix — record() called with {isProbe:true} — stays in
// place at the call site rather than re-testing HostedEntitlementResolver
// itself (covered in packages/shared/src/entitlements/__tests__/resolver.test.ts).
describe('DD REST entitlement-check probe', () => {
  it('records via the isProbe flag so it never counts as an upgrade_cta', () => {
    const source = readFileSync(new URL('../http.ts', import.meta.url), 'utf8');
    const marker = "endpoint:'rest:entitlement_check'";
    const markerIndex = source.indexOf(marker);
    expect(markerIndex).toBeGreaterThan(-1);
    const nearby = source.slice(markerIndex, markerIndex + 400);
    expect(nearby).toMatch(/entitlementResolver\.record\(decision,\s*false,\s*\{\s*isProbe:\s*true\s*\}\)/);
  });
});
