# Hosted entitlement geo-tier design

## Scope and principles

This design applies subscription enforcement only to hosted HTTP execution. Self-hosted MCP/stdio execution keeps every compiled connector and does not require a cz-agents account or token.

Permission, quota and abuse rate limiting are independent:

- **permission**: coverage and depth entitlement;
- **quota**: optional account usage limits and the existing token counters;
- **rate limit**: short-window IP/transport protection.

## Core types

```text
CoverageTier = core | extended
DepthTier    = basic | ddplus
Source       = plan | trial | grandfathered | manual | promotion
Mode         = off | observe | enforce
Decision     = allowed | gated | invalid
Dimension    = coverage | depth | usage
```

An entitlement request contains a server-derived account context, raw country input, requested depth, endpoint/tool and request ID. It never accepts a client-provided account, plan or entitlement tier.

An entitlement decision includes normalized country, country group, effective coverage/depth, source, policy version, required tier, mode and whether the upstream may run. Stable error serialization is shared by MCP and REST.

## Effective entitlement resolution

1. Resolve anonymous or validate bearer token without consuming business quota.
2. Derive a pseudonymous/stable account key from the authenticated token record.
3. Map a known active plan token to baseline axes. Unknown values default to Core/Basic.
4. Load active, time-valid account entitlement rows.
5. Resolve each axis independently; explicit active rows override the plan baseline.
6. Resolve a normalized country and active country policy.
7. Apply country override precedence: active deny, active allow, then tier coverage.
8. Apply depth independently.
9. Check configured usage limits atomically. No limit means no new quota.

No source is inferred from email or a hardcoded account ID. Override rows carry their source and validity window.

## Baseline plan mapping

The compatibility mapping is deliberately centralized and configurable in code while policy/overrides remain data-driven:

| Existing token tier | Coverage | Depth |
| --- | --- | --- |
| anonymous, free, starter, trial, basic, unknown | Core | Basic |
| pro, agency, enterprise, unlimited | Extended | DD+ |
| real-estate-only tiers | Core | Basic unless an account override grants more |

The approved launch bundle is intentionally simple: Free = Core + Basic; Compliance (€99, represented by `pro`) = Extended + DD+; Agency (€199) = the same permission axes plus the plan's higher quota and monitoring capacity. Coverage and depth remain separate in the resolver so a later unbundle does not require redesigning enforcement.

An unexpired token with an expiry and no paid subscription is represented as source `trial`; otherwise token-derived access is source `plan`. Explicit DB rows may replace either axis and use all required source values.

## Country policy and normalization

Policy is an atomically loaded snapshot keyed by canonical ISO alpha-2. Each row contains coverage group, enabled flag, aliases, version and audit metadata.

Normalization performs Unicode NFKC, trim and case-folding, then resolves either a canonical two-letter code or exact normalized alias. `UK`, `uk`, `GB` and `United Kingdom` resolve to `GB`. Alias collision or a code absent from the snapshot invalidates the entire snapshot; unknown request input returns `invalid_country`.

Reviewed initial rows classify implemented `EE`/`NO` as enabled Extended coverage. `BE`/`LT` retain Extended pricing classification but start disabled until connector-quality verification succeeds. Norway is EEA, not EU; customer-facing positioning must not imply otherwise.

## Storage and cache

All entitlement tables are additive in the shared token SQLite database. `EntitlementStore` owns schema creation and transactional writes. Policy changes increment the singleton active version in the same transaction as row/audit changes.

`CountryPolicyCache` keeps the last fully validated snapshot and refreshes after a short TTL. A refresh reads metadata and rows in one SQLite transaction. A failed refresh uses a previous valid snapshot and marks it stale; without one, the decision fails closed before upstream.

## Hosted hook boundary

Transport-neutral server builders accept an optional lookup authorization hook. The default hook is absent and means unrestricted connector execution. The stdio entry points use that default.

Hosted HTTP entry points instantiate the resolver and pass the hook. Every tool invokes it immediately after input normalization and before any adapter/client call. REST handlers use the same resolver directly. This structure makes direct adapter tests possible while preventing an alternate hosted route from skipping enforcement.

## Multi-country behavior

A country-less EU Registry search expands to the adapter country set. Each country is checked separately:

- allowed countries are scheduled exactly once;
- gated/invalid/disabled countries are never scheduled in `enforce`;
- a partial response includes static `coverage_preview` entries;
- if nothing is allowed, the MCP result is a stable structured error;
- `observe` records `would_gate` but schedules the adapter to preserve behavior.

No preview performs an upstream lookup.

## Error contracts

Coverage and depth gates use HTTP 402 to match the existing payment-required convention. Authentication stays 401, quota stays 429, invalid country is 400 and policy unavailable is 503.

MCP returns an error result with a JSON text block and structured content. Required stable fields are preserved even if older clients only display text.

The upgrade URL comes from `HOSTED_UPGRADE_URL`, defaulting centrally to `https://cz-agents.dev/pricing.html`.

## Feature modes

- `off`: resolver bypasses policy gating and emits no blocking decision; current behavior remains.
- `observe`: evaluates all axes and records `would_gate=true`, but returns `upstream_allowed=true`.
- `enforce`: a gated/invalid decision returns before upstream.

Unknown feature-flag values fail safe to `off` during development and produce a startup warning. Production configuration changes are outside this branch.

## Telemetry and report

`entitlement_events` stores allowlisted metadata only: timestamp, pseudonymous account key, country/group, effective axes, decision, dimension, required tier, policy version/source, mode/would-gate, upstream flags, endpoint/tool and request ID.

A CLI report aggregates the last 30 days by country and answers account intent, gated calls and avoided upstream calls. Conversion/CTA events use the same event table with explicit event kinds; no company data is accepted.

## Migration and downgrade

Schema creation is non-destructive. The application can roll back to the previous image while new tables remain inert. The documented destructive table-drop downgrade is never automatic and requires backup plus explicit operator approval.
