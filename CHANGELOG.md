# Changelog

## 2026-10-15 — sanctions degraded screening guard

- `@czagents/sanctions` 0.1.7 — an empty, stale, or unverified sanctions database now returns only an MCP error guard for no-match screening; it never pairs that guard with a clean verdict.

## 2026-10-14 — npx startup fix

- `@czagents/adis` 0.1.5, `@czagents/ares` 0.1.10, `@czagents/dd` 0.3.10, `@czagents/isir` 0.2.5, `@czagents/realestate` 0.3.3, `@czagents/sanctions` 0.1.6, `@czagents/eu-registry` 0.8.1 — fix: stdio server now starts via `npx -y @czagents/<pkg>` / global install (the direct-run check compares realpaths, so the bin symlink in `argv[1]` no longer prevents `main()` from running).
- `@czagents/sanctions` 0.1.6 — add default bin `sanctions` (stdio server) so `npx -y @czagents/sanctions` resolves an executable; `cz-agents-sanctions` and `cz-agents-sanctions-refresh` kept.
- `@czagents/eu-registry` 0.8.1 — add default bin `eu-registry` (stdio server) so `npx -y @czagents/eu-registry` resolves an executable; existing bins kept. Ingest CLIs get the same realpath fix.
- `@czagents/sanctions` 0.1.6, `@czagents/payqr` 0.1.13 — fix: depend on `@czagents/shared` ^0.1.12; they import `@czagents/shared/x402`, which published 0.1.11 does not export (`ERR_PACKAGE_PATH_NOT_EXPORTED` on start). Publish `@czagents/shared` 0.1.12 first.
- `@czagents/shared` 0.1.12 — `cz-agents-entitlements` CLI gets the same realpath fix.
