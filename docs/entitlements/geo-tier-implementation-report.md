# Hosted entitlement geo-tier implementation report

Status: reviewed implementation merged locally into `main` from `agent/hosted-entitlement-geo-tiering`. No commit was pushed, no production deployment ran, no production database or policy was changed, and no feature flag was enabled.

## Result

The implementation adds a hosted-only entitlement boundary with three independent axes:

- coverage: `core | extended`;
- depth: `basic | ddplus`;
- usage: separately named limits and counters, independent from transport rate limits.

Country policy and account exceptions are stored in additive SQLite tables, versioned, audited and editable through an internal CLI without rebuilding the application. Hosted HTTP entry points resolve the authenticated server-side account and call one central resolver before upstream work. The npm/stdio construction path retains an unrestricted default and does not import the hosted entitlement subpath.

The rollout flag is `HOSTED_GEO_TIER_ENFORCEMENT=off|observe|enforce`; Compose defaults to `off`. This work did not change that production value.

## Supported-country ground truth

The EU Registry adapter map contains 14 named non-Czech adapters:

`AT, DE, DK, EE, ES, FI, FR, GB, IT, NL, NO, PL, SE, SK`

ARES adds `CZ`, producing 15 named raw-registry jurisdictions across the two services.

The supplied business list is also 15 countries, but it is a different set:

- Core: `GB, CZ, SK, PL, NL`;
- Extended and implemented: `DE, ES, IT, FR, AT, DK, FI, SE`;
- Extended but no named adapter: `BE, LT`;
- implemented and subsequently approved as Extended: `EE, NO`.

The reviewed seed stores `EE` and `NO` as enabled Extended coverage. `BE` and `LT` remain Extended but disabled until connector-quality verification. Norway is EEA rather than EU and must be described accurately in product positioning.

The historic “14” is the exact non-Czech adapter count. “15” is correct for those adapters plus Czech ARES, and also for the arithmetic 5 + 10 business policy, but the two 15-country sets are not identical. In addition, the generic VIES VAT tool historically accepts more prefixes than the named adapter map. Hosted execution now gates the normalized VAT prefix before VIES; self-hosted execution remains unrestricted.

## Data model and policy operations

The additive schema creates:

- `entitlement_policy_meta`;
- `country_policies`;
- `account_entitlements`;
- `account_country_overrides`;
- `entitlement_usage`;
- `entitlement_events`;
- `entitlement_policy_audit`.

Account entitlements support `plan`, `trial`, `grandfathered`, `manual` and `promotion`, validity windows, coverage/depth tiers and usage-limit JSON. Country overrides support time-bounded allow or deny decisions; deny wins. No email address or account ID is hardcoded in application logic.

The `cz-agents-entitlements` CLI supports policy seed/change, account grant, country override and 30-day intent reporting. Mutations require an actor, append audit data and bump the active policy version. Resolver cache TTL is configurable and a valid last snapshot is retained when a later policy refresh fails. With no valid snapshot, enforce mode fails closed for every country.

The migration is non-destructive. `packages/shared/migrations/hosted-entitlements-downgrade.sql` provides an explicit offline removal script; normal rollback leaves the inert additive tables in place.

## Enforcement points

### EU Registry

- HTTP MCP authentication and server-side account context;
- explicit country search and exact lookup;
- country-less fan-out, evaluated per adapter before `Promise.all` scheduling;
- VAT prefix normalization before VIES;
- MCP structured `tier_required`/validation error;
- static no-upstream coverage preview for filtered adapters.

### ARES

- all hosted MCP tools through the common server-builder hook;
- REST company/search/statutary/bank-account routes;
- sandbox route before its ARES client call;
- `CZ` is still unrestricted Core for the default free account when a valid policy is loaded.

### DD and webapp

- DD MCP tools are classified as Basic or DD+ before their handlers execute;
- DD REST report and risk routes use the same resolver;
- the no-upstream `/v1/entitlements/check` endpoint lets private webapp cache/DB paths check permission without generating registry COGS;
- `/api/dd`, `/api/bulk-lookup`, watchlist, watch-entity and scheduled rechecks forward the user's server-side Compliance MCP bearer and stop before cache/upstream/state mutation on a gate;
- authentication, entitlement permission, usage entitlement, old report quota and IP rate limiting remain distinct;
- preflight authentication does not consume report quota, including in `off` mode.

The central upgrade URL is configured once per hosted service. REST uses stable JSON and MCP returns the same body in an `isError: true` tool result.

## Evidence: no upstream call when gated

The integration tests use in-memory MCP transports and mocked clients at the upstream boundary:

- EU Registry Extended `get_company`: gated, adapter `getById` called 0 times;
- EU Registry country-less search: allowed adapter called once, gated adapter called 0 times;
- EU Registry VIES lookup: gated before VAT fetch, fetch called 0 times;
- ARES Core-policy denial: `getByIco` called 0 times;
- DD DD+ denial: ARES client called 0 times;
- allowed EU Registry, ARES and Basic DD cases call the expected upstream exactly once.

The tests also assert that gated telemetry is recorded with `upstream_avoided=1`. No registry payload, company identifier, email or raw account ID is stored in entitlement telemetry.

## Evidence: open-source path remains complete

- `packages/eu-registry/src/index.ts` and `packages/shared/src/index.ts` contain no hosted entitlement import.
- Hosted functionality is exported only through `@czagents/shared/entitlements` and instantiated by HTTP entry points.
- `buildEuRegistryServer()` without an authorizer remains unrestricted.
- Regression coverage calls GB, DE and alias `UK -> GB` without an account, token or hosted policy.
- The npm dry-run contains all 14 adapter implementations and the unrestricted stdio entry point.
- VIES remains generic in the self-hosted/default server path.

## Telemetry and intent report

`entitlement_check`, `upgrade_cta` and optional `conversion` events have allowlisted structured fields. Accounts are salted pseudonyms; request payloads and registry results are excluded. The report answers, by country and time window:

- unique requesting accounts;
- total and gated requests;
- upgrade CTA count;
- avoided upstream calls;
- highest-intent jurisdictions by gated/request count.

Conversion event storage is prepared, but Stripe-to-conversion event ingestion is intentionally not wired in this prototype because prices/products and conversion attribution were outside the authorized changes.

## Changed files

### `cz-agents-mcp`

- `.gitignore`, `docker-compose.yml`;
- four entitlement design/feasibility/rollout/test documents and this report;
- `packages/shared/package.json`, billing quota split and tests;
- `packages/shared/src/entitlements/**`;
- `packages/shared/migrations/**`;
- ARES HTTP/server integration and tests;
- DD HTTP/server integration and tests;
- EU Registry HTTP/server integration and tests.

### `cz-agents-webapp`

- `lib/compliance-mcp-token.ts`;
- `lib/dd-mcp.ts` and tests;
- DD, bulk, watchlist and watch-entity API routes;
- review-event and watchlist scanner server-side bearer propagation;
- review-event test server-only mock.

## Verification results

- MCP monorepo build: passed for all workspaces.
- MCP monorepo tests: 574 passed, 1 pre-existing skipped.
- Webapp tests: 169 passed across 31 files.
- Webapp optimized Next.js build: passed, 449 routes/pages generated.
- Compose interpolation/config validation: passed; only expected warnings for unset local secrets.
- `git diff --check`: passed.
- EU Registry npm package dry-run: passed, 82 files, all named adapters present.
- OS import isolation static check: passed.
- No live production E2E, production deploy, production migration or paid upstream smoke was executed. The local MCP integration matrix covers the six requested allow/gate paths with mocked upstream boundaries; a stage/live smoke remains a rollout approval step.

The Next build emits an existing Turbopack warning about broad file tracing from the Stripe webhook import graph; compilation and TypeScript both complete successfully and the warning is unrelated to entitlements.

## Migration and rollout

1. Review this diff and verify `BE/LT` connector quality; `EE/NO` are approved as Extended.
2. Preserve the approved launch mapping: Free = Core + Basic; Compliance/`pro` = Extended + DD+; Agency = Extended + DD+ plus its higher quota and monitoring capacity. Legacy `enterprise`/`unlimited` remain Extended + DD+ for compatibility.
3. Back up the shared token database.
4. Deploy with the flag still `off`; boot and smoke all services.
5. Seed the initial policy only with explicit production approval.
6. Add explicit internal/test overrides and any justified time-bounded grandfathering.
7. Separately approve `off -> observe`; inspect intent/alias/account telemetry.
8. Run stage/live safe-subject smokes.
9. Separately approve `observe -> enforce`.

Do not combine the first policy change and first enforcement activation.

## Rollback

Fast rollback is `enforce -> observe -> off`, followed by the previous application image if needed. Additive tables should normally remain for compatibility and audit. A policy rollback writes a new audited version restoring earlier values; it never rewrites version history. Destructive table removal requires a database backup and separate approval.

## Remaining risks and decisions

- `BE` and `LT` need verified connectors or must remain unavailable; `EE` and `NO` are enabled Extended.
- Existing product terminology and trial behavior do not perfectly match the new Basic/DD+ model. In particular, enforcing DD+ can change historical trial/full-report expectations; observe telemetry and explicit grandfathering are required first.
- Plan entitlement is presently inferred from trusted token DB tier strings because no dedicated EU Registry subscription service exists. The launch bundle is approved, but future cross-product unbundling should move plan mapping into dedicated billing configuration.
- Historical telemetry did not store country, so previous Extended usage cannot be reconstructed reliably.
- Policy uses a short TTL plus last-known-good snapshot, not cross-process push invalidation; bounded staleness equals the configured TTL.
- SQLite is appropriate for the current single shared-volume deployment. Multi-host horizontal writers would require a transactional shared database.
- Live external-adapter E2E remains a stage rollout action so this branch does not create production COGS or alter customer state.

## Steps requiring Martin's approval

- push/PR publication if desired;
- any deployment;
- production DB backup and policy seed/change;
- any later country reclassification or plan unbundling;
- internal/customer overrides or grandfathering;
- `off -> observe` and later `observe -> enforce`;
- live paid-upstream smoke;
- Stripe product, price or webhook-attribution changes;
- destructive downgrade.
