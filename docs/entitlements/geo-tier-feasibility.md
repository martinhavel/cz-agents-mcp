# Hosted entitlement and geo-tier feasibility

Status: implementation feasibility complete; no production deployment or production policy change performed.

## Executive conclusion

The hosted EU Registry is not implemented in `cz-agents-webapp`. It is the HTTP entry point of the public `@czagents/eu-registry` workspace, deployed as `cz-agents-eu-registry` and exposed at `https://eu-registry.cz-agents.dev/mcp`. The same workspace also exposes the unrestricted local stdio entry point distributed through npm.

The safe implementation boundary is therefore:

- keep country normalization and registry adapters transport-neutral;
- add an optional authorization hook to transport-neutral servers, with an unrestricted default;
- instantiate the hook only from hosted HTTP entry points;
- store hosted policy, account entitlements, overrides, usage limits and audit events in the existing shared token SQLite database;
- reject or filter a country before invoking an adapter or other upstream client;
- prove by regression test that the npm/stdio construction path never imports or instantiates hosted enforcement.

This design supports policy changes without an application build and does not place a subscription requirement on self-hosted users.

## Ground truth: services and entry points

### Raw non-Czech registry lookup

The implementation is in `packages/eu-registry`.

| Entry point | Transport | Tools/routes | Hosted today |
| --- | --- | --- | --- |
| `src/index.ts` | MCP stdio | all EU Registry tools | no; npm/self-hosted |
| `src/http.ts` | Streamable HTTP MCP | `/mcp` | yes |
| `src/http.ts` | HTTP | `/v1/health`, `/health`, `/healthz`, `/metrics` | yes |
| `src/http.ts` | HTTP | other `/v1/*` | returns 404; no lookup REST API exists |
| `src/server.ts` | internal server builder | `search_company`, `get_company`, `lookup_company_by_vat` | shared by stdio and HTTP |

There is no EU Registry webapp server action, batch REST endpoint or private internal proxy in `cz-agents-webapp`. Repository-wide searches found no invocation of the three EU Registry tools from the webapp.

The effective multi-country/batch path is `search_company` with no `country`: it currently fans out concurrently to every adapter. This is both a bypass risk and the largest avoidable upstream fan-out.

### Czech raw registry lookup

Czech company identity and raw registry data are served separately by `packages/ares`:

- hosted MCP `/mcp` through `packages/ares/src/http.ts`;
- hosted REST and sandbox routes in the same HTTP entry point;
- local stdio through the ARES package entry point;
- shared server builder `packages/ares/src/server.ts`.

ARES is a Core coverage path. It must remain successful for anonymous/free hosted callers. It still needs the common hosted policy check so a disabled CZ policy, telemetry and future usage entitlement cannot be bypassed through REST, sandbox or MCP.

### Analysis/depth paths

`packages/dd` is the current cross-source due-diligence implementation. Its hosted HTTP entry supports:

- MCP tools from `packages/dd/src/server.ts`;
- `GET /v1/dd/{ico}` and `GET /v1/dd/{ico}/risk`;
- GLEIF-based `get_eu_dd_report` with an optional country;
- Czech cross-source report, AML/sanctions, ownership, scoring, nominee, phoenix, address crowding and parent analysis.

The DD MCP server currently uses a server-construction tier (`free`, `compliance`, `agency`, `enterprise`) and local `requireTier` checks. REST chooses `basic` or `full` using whether the token tier is free. These are existing product gates, but they are not a central coverage/depth entitlement model and they do not support account overrides or policy versions.

No EU Registry-specific webapp batch endpoint exists. The webapp `/api/bulk-lookup` route is a Czech DD batch route and must use the same depth/account decision when the hosted entitlement integration reaches the private webapp.

### Country aliases and alternate inputs

Current EU Registry behavior is insufficient for enforcement:

- `search_company.country` and `get_company.country` accept exactly two characters and only lowercase the value;
- `gb` is the adapter key; `UK`, `uk` and full country names do not resolve to GB;
- unknown two-character codes on `get_company` look like a not-found result rather than a validation error;
- `lookup_company_by_vat` strips spaces, dots and hyphens, uppercases the VAT and derives its country from the first two ASCII letters;
- a country-less search calls every adapter.

A single ISO alpha-2 normalizer must run before policy resolution on all hosted paths. Aliases are data-driven; `UK -> GB` is mandatory. Input is Unicode NFKC-normalized, trimmed and case-folded before exact alias resolution. Unknown and ambiguous inputs are validation errors, never Core fallbacks.

## Supported-country ground truth

The EU Registry adapter map contains **14 non-Czech countries**:

`AT, DE, DK, EE, ES, FI, FR, GB, IT, NL, NO, PL, SE, SK`

ARES adds `CZ`, so the actual combined raw-registry portfolio contains **15 countries**.

There is also a broader, previously implicit capability: `lookup_company_by_vat` accepts any syntactically valid two-letter VAT prefix and sends it to VIES without checking the adapter map. Therefore 14 is the exact count of named national/GLEIF adapter countries, not a hard upper bound on countries reachable through the package. Hosted coverage must gate the normalized VAT prefix before VIES; self-hosted VIES remains unrestricted. Countries reachable only through this generic VIES path are not marketed as full national-registry connectors and are invalid in hosted `enforce` until present in the policy.

The business policy supplied for this implementation also contains 15 codes, but it is not the same set:

- Core: `GB, CZ, SK, PL, NL`
- Extended: `DE, ES, IT, FR, AT, DK, BE, FI, LT, SE`

Two requested codes have no adapter: `BE`, `LT`.

Two implemented codes are absent from the business classification: `EE`, `NO`.

Therefore the historic “14” can truthfully refer to the non-Czech EU Registry package, while “15” can truthfully refer to the combined EU Registry plus ARES portfolio. The supplied 5 + 10 policy is arithmetically 15 but describes a different country set. The reviewed initial policy classifies implemented `EE` and `NO` as enabled Extended coverage; `BE` and `LT` remain Extended but disabled/unavailable until their connectors are verified. `NO` is EEA rather than EU, which must remain explicit in product positioning. `off` mode preserves current runtime behavior.

## Existing auth, account, billing and limits

### Hosted MCP token store

`packages/shared/src/billing/tokenStore.ts` maintains the shared SQLite `tokens` table. The MCP compose stack mounts it at `/var/lib/czagents-tokens/tokens.db`; the private webapp mounts the same Docker volume.

The record already provides an opaque token, service, plan-like tier, Stripe customer/subscription identifiers, monthly quota/counter, credits, expiry and revocation. `createQuotaGuard` authenticates a service-specific bearer token and consumes quota. It is used by DD and sanctions, not EU Registry or ARES.

Observed production schema has drift beyond the TypeScript union: active `ddplus` rows and an `unlimited` DD tier exist even though the public `ServiceKind`/`TierKind` types do not declare them. The entitlement implementation must tolerate existing string values and must not destructively rewrite token rows.

### Private webapp

`cz-agents-webapp` has Auth.js sessions and Prisma models `User`, `Subscription`, `McpApiToken`, `ComplianceOrg` and `McpAuditLog`.

- subscription tiers include trial/basic/pro/agency/enterprise-style values;
- `Subscription` carries status, Stripe IDs, period, counters and trial expiry;
- `McpApiToken` maps a plaintext MCP token to a server-side user and service;
- Stripe and OAuth issuance write compatible rows into the shared token DB;
- existing upgrade routing points to the central pricing page;
- `McpAuditLog` is too narrow for the requested entitlement telemetry.

Entitlement decisions must use the account derived from the authenticated token/session. A request-provided account ID or tier is never accepted.

### Production compatibility snapshot (read-only, 2026-07-13)

Aggregate-only inspection found:

- 4 webapp users and 4 active subscriptions: one each `trial`, `pro`, `agency`, `re_pro`;
- active Compliance MCP shadow tokens for 2 accounts;
- active shared DD tokens for 4 account keys, including one legacy `unlimited` token;
- active DD+ tokens for 4 account keys;
- no EU Registry token service exists;
- 34 retained tool-event files contain zero EU Registry tool calls.

Historical tool telemetry did not persist a country field, so country-level historic usage cannot be reconstructed reliably. This is a migration limitation. It is not evidence that no request occurred outside the retained window.

## Upstream COGS and earliest rejection point

| Adapter/path | Upstream/cost characteristic | Earliest safe gate |
| --- | --- | --- |
| GB Companies House | credentialed API | before `searchByName`/`getById` |
| DK CVR | credentialed upstream | before adapter call |
| SE Bolagsverket | OAuth/credentialed exact lookup; GLEIF search | before adapter call |
| FR SIRENE | remote official API | before adapter call |
| FI PRH | remote official API | before adapter call |
| NO BRREG | remote official API | before adapter call |
| SK ORSR/RPO | remote registry | before adapter call |
| PL KRS | remote registry | before adapter call |
| DE and name-search fallback countries | GLEIF remote, with local TTL cache | before cache/upstream adapter call |
| NL/IT/AT/ES exact VAT | VIES remote | after VAT-country parse, before fetch |
| `lookup_company_by_vat` | VIES remote | after normalization, before `lookupCompanyByVat` |
| EE | local SQLite bulk index | before local adapter call for consistent policy |
| CZ ARES | remote official API | before `AresClient` call |
| DD/DD+ | multiple ARES/VR/ISIR/ADIS/GLEIF/sanctions calls | before report/tool client calls |

The earliest common safe point is inside each transport-neutral tool/REST handler after authenticated account resolution and country normalization, but before selecting or calling any adapter/client. For country-less search the resolver must evaluate every candidate and pass only allowed adapters to `Promise.all`; gated adapters must never be scheduled.

## Current request flow

### EU Registry hosted MCP

```text
HTTP rate/origin/body checks
  -> MCP session/transport
  -> tool schema
  -> lowercase country (or all adapters)
  -> telemetry log
  -> adapter/VIES upstream
  -> tool response
```

There is currently no authentication, account, policy, coverage or quota decision.

### DD hosted MCP/REST

```text
HTTP checks
  -> service-specific bearer lookup and immediate quota consumption
  -> tier fixed when MCP session is built / REST paid boolean
  -> local requireTier or depth selection
  -> upstream clients
  -> response/audit
```

Permission, quota and transport request rate are currently coupled more closely than desired: quota is consumed for MCP protocol requests, not only business tool execution.

## Proposed request flow

```text
HTTP authentication (optional anonymous Core where allowed)
  -> server-side account resolution
  -> MCP/REST input validation
  -> ISO country normalization / per-country expansion
  -> versioned country-policy snapshot
  -> coverage permission
  -> depth permission
  -> usage quota decision (separate from permission)
  -> transport/IP rate limiter (independent abuse control)
  -> allowed adapter/client call exactly once
  -> response
  -> structured entitlement telemetry
```

In `observe`, a would-be gate is recorded as `would_gate` and execution continues. In `enforce`, a gate returns before upstream. In `off`, existing behavior is preserved.

## Proposed data model

The non-destructive SQLite migration creates separate tables in the shared token DB:

### `entitlement_policy_meta`

- singleton active policy version;
- created/updated timestamps and change source.

### `country_policies`

- `country_code` ISO alpha-2 primary key;
- `coverage_group` (`core`, `extended`);
- `enabled`;
- JSON `aliases`;
- `policy_version`;
- `updated_at`, `updated_by`, `change_source`.

### `account_entitlements`

- stable row ID and server-derived `account_id`;
- nullable `coverage_tier` and `depth_tier` (nullable allows one-axis overrides);
- JSON `usage_limits`;
- `policy_version`, `source` (`plan`, `trial`, `grandfathered`, `manual`, `promotion`);
- `valid_from`, optional `valid_until`;
- audit timestamps and actor/source.

Multiple rows allow a base plan and time-bounded overriding grants. Resolution is deterministic by source/creation precedence and validity interval.

### `account_country_overrides`

- account, normalized country, `allow`/`deny`;
- source, reason/change source, policy version;
- validity interval and audit timestamps.

An explicit deny wins over allow and plan coverage. No account identifiers are hardcoded in application code.

### `entitlement_usage`

- account, metric and period key;
- atomic counter and update timestamp.

Supported metrics initially include `requests_per_day`, `extended_requests_per_month`, `ddplus_reports_per_month` and `monitoring_entities`; unset limits mean no new quota. Existing token quota remains operational and distinct.

### `entitlement_events`

Append-only structured event rows contain only the requested decision metadata and a pseudonymous account key. No company identifiers, names or raw payloads are stored. Indexes support 30-day country intent reports.

### `entitlement_policy_audit`

Append-only before/after metadata for CLI policy and override changes.

Migration is additive (`CREATE TABLE IF NOT EXISTS` and indexes). Rollback is application rollback plus leaving inert tables in place; an optional downgrade script may drop only the new empty/inert tables after an explicit backup and approval.

## Policy storage, cache and failure behavior

The resolver reads a consistent policy snapshot in one SQLite read transaction. It caches the last valid snapshot with a short configurable TTL and checks the active version on refresh. The internal CLI changes rows and increments the version in one write transaction, which invalidates all process caches within the TTL without a build or deploy.

Failure rules:

- never synthesize `allow all`;
- retain the last fully validated snapshot if storage temporarily fails;
- without a valid snapshot, return an unavailable/invalid decision and call no upstream;
- Core is allowed only from a loaded valid policy;
- unknown, disabled and alias-conflicting countries fail closed;
- stale-snapshot use is logged; successful version checks replace it promptly.

## Enforcement and error compatibility

Hosted enforcement is exposed as one resolver and optional server hook. MCP returns `isError: true` plus a JSON text block and `structuredContent` where supported. REST returns the existing JSON error envelope extended with stable fields. Webapp callers receive the same typed decision for an upgrade CTA.

Coverage example fields are `error=tier_required`, `dimension=coverage`, `required_tier=extended`, normalized `country`, `country_group=extended`, central `upgrade_url` and a stable message. Depth uses `dimension=depth` and `required_tier=ddplus`.

Unknown/disabled country is a validation/availability error, not a tier gate. Existing generic clients still receive a text/JSON error; structured-aware clients can branch on stable fields.

Preview for a gated country contains only static policy/adapter metadata (country, registry/source name, connector availability, field categories, coverage group and CTA). It never invokes an adapter, VIES or GLEIF.

## Open-source isolation

The npm/stdio path constructs `buildEuRegistryServer()` without a hosted hook. Its default is unrestricted. It does not open the hosted token/policy database, authenticate an account or read `HOSTED_GEO_TIER_ENFORCEMENT`.

The hosted HTTP path explicitly constructs the hosted resolver and passes the hook. Country normalization and adapter metadata may be shared. Subscription/account enforcement is not imported by `src/index.ts` and cannot become a prerequisite for local lookup.

Regression tests must construct the stdio/server-default path with mocked adapters and prove Core, Extended and `UK -> GB` all reach the adapter without hosted account/token state.

## Security analysis

- **Alias/case/whitespace/Unicode bypass:** one NFKC normalizer and policy alias index before adapter selection.
- **Unknown fallback:** explicit validation failure; no Core default.
- **Country-less/batch bypass:** resolve every adapter country; never schedule gated adapters.
- **VAT prefix bypass:** parse and normalize prefix before VIES fetch.
- **Alternative REST/MCP path:** both invoke the same resolver; raw internal adapters remain transport-neutral but hosted handlers cannot call them without the hook.
- **Direct internal connector call:** no public hosted route exposes adapters; integration tests call every registered hosted tool/REST handler.
- **Account spoofing:** ignore request account/tier fields; derive account from validated opaque token/session.
- **Invalid subscription/token:** revoked, expired and unknown bearer values fail authentication. Anonymous gets only configured anonymous defaults.
- **Expired override/trial:** validity checked against server time on every decision.
- **Policy race:** version and rows are read transactionally; cache swaps complete validated snapshots only.
- **DB/cache outage:** last valid snapshot only; no snapshot means no lookup and no upstream.
- **Sensitive telemetry:** allowlisted fields only, pseudonymous account IDs, no registry payload.

## Compatibility and migration risks

1. EU Registry is anonymous today. Turning on authentication-only behavior would break clients, so anonymous Core remains supported.
2. Country-less search currently returns any supported adapter. Under enforcement it becomes a safe partial result with explicit gated-country metadata; clients expecting every country may observe fewer results.
3. `UK` and full names become accepted aliases, while unknown codes change from not-found to validation error.
4. Existing plan/tier strings have schema drift. Resolution needs an explicit, tested mapping and a safe unknown-tier default (Core/Basic, never Extended/DD+).
5. No historic country telemetry exists. Use `observe` before enforcement to learn actual demand.
6. `BE`/`LT` connector quality must be verified before enabling them; `EE`/`NO` are approved as Extended.
7. The current quota guard consumes on protocol requests. Permission must run before business usage consumption; refactoring must preserve existing token quota contracts.
8. MCP sessions currently capture a tier when constructed. Entitlement checks must resolve current account/policy per tool request so revocation and policy updates are not frozen for the session lifetime.

## Recommended implementation sequence

1. Add shared country normalizer, typed decisions, SQLite migration/store, snapshot cache, resolver, telemetry and read-only intent report.
2. Add internal policy CLI with transactional version bump and audit; seed `EE`/`NO` as enabled Extended and unsupported `BE`/`LT` as disabled Extended.
3. Add optional pre-upstream hooks to EU Registry, ARES and DD builders; defaults remain unrestricted.
4. Wire hooks only from hosted HTTP entry points and centralize upgrade URL/feature mode.
5. Make country-less search filter per-country decisions and return no-cost previews.
6. Replace/bridge DD hosted tier checks with the depth decision while keeping a compatibility response.
7. Add unit, integration and safe E2E fixtures, including exact upstream call counts and OS isolation.
8. Run locally with `off`, then `observe`; prepare but do not perform production deployment.
9. After Martin approves classification/mapping and reviews telemetry, separately approve production `observe`; `enforce` is a later explicit decision.

## Files expected to change

Public MCP repository:

- `packages/shared/src/entitlements/*` and shared exports/tests;
- `packages/shared/src/billing/*` only where non-consuming authentication separation is required;
- `packages/eu-registry/src/server.ts`, `http.ts`, normalizer/metadata/tests;
- `packages/ares/src/server.ts`, `http.ts` and tests;
- `packages/dd/src/server.ts`, `http.ts` and tests;
- workspace scripts/package metadata for the policy CLI and test report;
- `docs/entitlements/*`.

Private webapp follow-up/integration, if required by the final implementation boundary:

- Prisma additive migration/models for webapp visibility, or an internal read-only adapter to the shared token DB;
- Auth/Stripe token issuance mapping only if a dedicated EU Registry token is chosen;
- Czech DD/bulk server actions to consume the same resolver contract;
- pricing/upgrade configuration references, without changing products or prices.

No production deploy, production policy mutation, Stripe price/product change or `enforce` flag change is part of this branch.
