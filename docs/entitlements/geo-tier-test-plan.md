# Hosted entitlement geo-tier test plan

## Unit tests

- Core country + Core account allows raw/basic.
- Extended country + Core account gates coverage.
- Extended country + Extended account allows.
- Core + Basic + DD+ request gates depth.
- Core + DD+ allows advanced analysis.
- active account allow and deny overrides; deny wins.
- expired trial/override is ignored; grandfathered source resolves.
- `UK`, `uk`, `GB`, `United Kingdom`, whitespace and NFKC forms normalize to `GB`.
- unknown, disabled and alias-collision inputs are invalid.
- policy version change replaces the cache snapshot.
- storage failure retains the last valid snapshot; no snapshot fails closed.
- permission, usage quota and IP rate limits remain separate decisions.

## Integration tests

- gated single-country MCP request calls its adapter zero times.
- allowed request calls its adapter exactly once.
- VAT gate occurs before VIES fetch.
- country-less search checks every adapter and schedules only allowed ones.
- MCP gate exposes stable structured fields and no-cost preview.
- REST gate uses stable HTTP/error fields.
- ARES MCP/REST CZ raw uses the shared hosted policy and succeeds for Core.
- DD hosted paths use the depth axis before cross-source clients.
- policy CLI changes a DB row/version without rebuilding; cache observes it within TTL/invalidation.
- stale cache is bounded by refresh checks and never becomes allow-all.
- entitlement telemetry contains no company identifiers/payloads.

## Open-source regressions

Construct the default local server path with mock adapters and no token/policy DB:

- Core `GB` reaches its adapter;
- Extended `DE` reaches its adapter;
- `UK` reaches the `GB` adapter;
- no hosted environment variable or account token is required;
- package dependency/import inspection confirms stdio does not import hosted enforcement.

## Safe E2E matrix

Use existing project-approved public fixtures and mocked paid upstreams where credentials or COGS would otherwise be incurred:

1. free hosted + CZ raw -> success;
2. free hosted + DE raw -> `tier_required`, zero upstream;
3. paid hosted + DE raw -> success/exactly one mocked or approved call;
4. free hosted + CZ DD+ -> depth gate;
5. DD+ hosted + CZ DD+ -> success;
6. local open-source + DE -> no hosted gate.

No production endpoint is mutated and no marketing claim/screenshot is produced from unverified output.

## Commands and evidence

Run workspace typecheck/build and targeted Vitest suites first, followed by the full workspace test command. Capture command, exit status and counts in the implementation report. The upstream-call proof is an assertion on injected mock call counts, not code inspection alone.
