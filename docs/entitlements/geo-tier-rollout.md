# Hosted entitlement geo-tier rollout

No production rollout is performed by this change.

## Before deployment

1. Preserve the approved `EE`/`NO` classification as enabled Extended coverage and keep Norway's EEA status explicit in positioning.
2. Keep `BE` and `LT` disabled until their connectors return correct data for reviewed known test entities.
3. Preserve the approved Free = Core + Basic, Compliance = Extended + DD+, Agency = Extended + DD+ plus higher quota/monitoring mapping; grant explicit, time-bounded overrides to internal/test accounts.
4. Review aggregate existing accounts/tokens; grant a `grandfathered` row only where verified history warrants it.
5. Back up the shared token SQLite database and verify restore.
6. Keep `HOSTED_GEO_TIER_ENFORCEMENT=off` for the first image boot and run smokes.

## Off to observe

Changing production to `observe` requires Martin's explicit approval.

Observe for at least one normal billing/usage window or until meaningful traffic exists. Confirm:

- no customer-visible gate;
- country aliases normalize as expected;
- `would_gate` counts have plausible country distribution;
- account resolution never trusts request fields;
- policy cache refreshes after a CLI version bump;
- no sensitive registry payload appears in telemetry;
- COGS estimates include country-less fan-out.

Use the bundled intent report for 30-day totals. Investigate unknown/disabled country demand before enforcement.

## Observe to enforce

This is a separate explicit business decision. Before changing the flag:

- approve final country policy;
- resolve any real Extended users with paid or grandfathered entitlement;
- verify Core raw and paid Extended E2E tests against safe public subjects;
- verify free CZ DD+ returns a depth gate;
- verify every gated integration mock reports zero upstream calls;
- confirm central upgrade URL and customer wording;
- prepare customer communication if existing behavior changes.

Never combine a policy reclassification and first enforcement activation in one operational change.

## Rollback

Fast rollback order:

1. set mode back to `observe` or `off` after explicit production approval;
2. verify health and Core/Extended smokes;
3. if application regression remains, redeploy the previously known-good image;
4. leave additive entitlement tables in place for evidence and compatibility;
5. restore the DB only for proven corruption, never merely to remove a policy decision.

Policy rollback uses the CLI to write an audited new version restoring prior values; it does not decrement or rewrite history. Table removal is optional, offline and destructive, requiring a backup and separate approval.

## Required approvals

- production image deployment;
- any production policy seed or edit;
- `off -> observe`;
- `observe -> enforce`;
- grandfathering real customer accounts;
- Stripe product/price changes;
- destructive DB downgrade.
