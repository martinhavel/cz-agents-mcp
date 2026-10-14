# cz-agents tool reference (for due diligence)

Source of truth: tool registrations in `packages/*/src/server.ts` of
[martinhavel/cz-agents-mcp](https://github.com/martinhavel/cz-agents-mcp). Names and
parameters below were checked against built servers and the six free hosted
endpoints with MCP `tools/list` (2026-10-14; see `evals/prompts.md`, "Test log"). Your client may prefix names, e.g. `mcp__dd__get_dd_report`.

Tier legend: **Free** = available anonymously on the hosted endpoint and via npx.
**Compliance+** / **Agency+** = gated inside the free `dd` server; on the free tier the
call returns `tier_required`. **DD+** = separate paid, hosted-only `ddplus` server.

## Endpoints

| Server | npm package (stdio) | Remote (Streamable HTTP) |
|---|---|---|
| dd | `@czagents/dd` | `https://dd.cz-agents.dev/mcp` |
| ares | `@czagents/ares` | `https://ares.cz-agents.dev/mcp` |
| isir | `@czagents/isir` | `https://isir.cz-agents.dev/mcp` |
| sanctions | `@czagents/sanctions` | `https://sanctions.cz-agents.dev/mcp` |
| adis | `@czagents/adis` | `https://adis.cz-agents.dev/mcp` |
| eu-registry | `@czagents/eu-registry` | `https://eu-registry.cz-agents.dev/mcp` |
| ddplus (paid) | — (closed source) | `https://ddplus.cz-agents.dev/mcp` *(hosted route answered anonymous initialization with HTTP 401 on 2026-10-14; authenticated catalogue not checked)* |

Remote URLs are taken from each package's `server.json` (`dd`, `ares`, …) and the
`PUBLIC_MCP_URL` default in `packages/dd/src/http.ts`.

## dd — due-diligence aggregator (`@czagents/dd`)

| Tool | Inputs | Returns | Tier |
|---|---|---|---|
| `get_dd_report` | `ico` (string, 7–8 digits), `depth` (`"basic"` default \| `"full"`) | Markdown summary + JSON `DdReport`: `ico`, `retrieved_at`, `basic_only`, `company` {name, legal_form, address, registered_on, dissolved_on, nace_codes, found}, `vat` {is_payer, dic, reliability ANO/NE/NENALEZEN, unreliable_since, bank_accounts}, `statutory_body[]` {name, role, since, datumNarozeni?, sanctions_match?}, `vr_checked`, `insolvency?`, `sanctions` {company_match?, any_statutory_match}, `red_flags[]` {code, severity, weight, description, source, evidence}, `risk_score` {value 0–100, level low/medium/high}, `ownership_network_teaser`, `esm_onramp` | Free for `basic`. `full` (adds ISIR for company + members, prior insolvent companies, virtual-address probe) is DD+ |
| `get_risk_score` | `ico` | `ico`, `company_name`, `value`, `level`, `top_flags` (top 5), `retrieved_at`, `unavailable_sources?` | Free (subset of `get_dd_report` basic — don't call both) |
| `get_owners` | `ico`, `max_depth` (1–5, default 5) | Direct + upstream VR ownership tree (`structuredContent`) + markdown; persons as name + birth year | Free |
| `person_companies` | `name` (≥2 chars), `birth_year?` | Czech VR companies linked to the person; same-name persons kept separate | Free — use only for persons in the subject company |
| `watch_entity` | `ico` | `status` (`ONBOARDING_REQUIRED` …), `persisted: false`, `monitoring_active: false`, `next_step.url` for the human | Free (onboarding stub; persists nothing) |
| `get_statutory_chain` | `ico`, `max_depth` (1–5, default 3) | Surname-heuristic chain of related companies; not a UBO source | Agency+ |
| `detect_nominee_director` | `ico` | 3-indicator "white horse" report, `riskScore` 0–100 | Compliance+ |
| `detect_phoenix` | `ico` | 3-indicator phoenix report, `riskScore` 0–100 | Compliance+ |
| `get_risk_timeline` | `ico` | `events[]` + `riskScore` | Compliance+ |
| `detect_address_crowding` | `ico` | Count of companies at the registered address + threshold band | Compliance+ |
| `get_eu_dd_report` | `identifier` (LEI or name), `country?` (ISO-2) | GLEIF entity + EU/OFAC sanctions screen + coverage notes | Compliance+ |
| `get_eu_parent` | `ico` | ARES → GLEIF parent match (`eu_parent`, confidence) or VR foreign-owner candidate | Compliance+ |

Notes:
- `depth: "basic"` does **not** query ISIR; the summary lists ISIR as "not checked".
  Use `isir.check_ico_insolvency`.
- In the stdio build (`npx @czagents/dd`) the ADIS client is not wired, so VAT
  reliability in the report may be `adis_not_configured`; use `adis.check_dph_payer`.
- `get_owners`/`person_companies` need a VR Postgres database. Without it they return
  `vr_not_configured` (expected for local npx unless you run your own VR mirror).

## ares — Czech Business Register (`@czagents/ares`)

| Tool | Inputs | Returns | Tier |
|---|---|---|---|
| `lookup_by_ico` | `ico` | Name, address, legal form, DIČ, founding date, trade activities; null if not found | Free |
| `search_companies` | `query?`, `city?`, `street?`, `psc?` (number), `nace?` (string[]), `pocet` (1–100, default 10), `start` (default 0) | Total count + list of matches (name, IČO, address) | Free — use to resolve a name to IČO |
| `search_by_address` | `street`, `city`, `psc?`, `pocet` (default 20) | Companies registered at the address; total count | Free |
| `search_by_nace` | `nace`, `city?`, `pocet` | Companies by CZ-NACE code | Free (not a DD tool) |
| `get_statutaries` | `ico` | Current statutory body (active members) | Free (already inside `get_dd_report`) |
| `get_owners` | `ico` | VR společníci / akcionáři with shares, incl. removed members with `datumZaniku`; empty list when not published | Free |
| `validate_dic` | `dic` | Format + MOD11 checksum, embedded IČO | Free, offline |
| `check_vat_payer` | `ico` | DIČ, tax office, transparent accounts | Free |
| `get_bank_accounts` | `ico` | Published VAT bank accounts | Free |
| `get_history` | `ico` | Previous names, address changes, trade-licence history | Free |
| `watch_entity` | `ico` | Same onboarding stub as `dd.watch_entity` | Free |

## isir — insolvency register (`@czagents/isir`)

| Tool | Inputs | Returns | Tier |
|---|---|---|---|
| `check_ico_insolvency` | `ico` | Active proceeding (spisová značka, start date, phase) or text "žádné aktivní insolvenční řízení v ISIR (k tomuto okamžiku)" | Free |
| `search_person_insolvency` | `name`, `dob?` (YYYY-MM-DD, strongly recommended), `only_active` (default true) | Matches for a natural person | Free — statutory members of the subject only |
| `poll_isir_events` | `since_id` (default 0) | Up to ~1000 raw ISIR events | Free — monitoring feeds, not single checks |

If ISIR is not configured (local stub without `ISIR_SOAP_ENABLED=1`) the answer says
`ISIR není nakonfigurován … dotaz NEPROBĚHL` → treat as **not verified**.

## sanctions — EU + OFAC screening (`@czagents/sanctions`)

| Tool | Inputs | Returns | Tier |
|---|---|---|---|
| `search_person` | `name`, `dob?` (YYYY or YYYY-MM-DD), `nationality?`, `threshold` (default 80), `limit` (default 20) | Matches `[confidence%] name`, `id`, `programs`, `matched_on` | Free |
| `search_entity` | `name`, `country?`, `threshold` (80), `limit` (20) | Same format, entities only | Free |
| `check_ico` | `ico`, `name?` | Exact IČO hit, optional fuzzy name fallback | Free (already inside `get_dd_report`) |
| `get_listing` | `id` (`source:list_id`, e.g. `ofac:12345`) | Full listing record (aliases, DOBs, nationalities, programs) | Free |
| `list_recent_updates` | `since`, `source?` (`eu`/`ofac`/`un`/`ofsi`/`fau`) | Added / removed / modified listings | Free — monitoring |
| `rescreen_portfolio` | `subjects[]`, `since`, `source?` | Re-screen a list | Paid via x402; only registered when x402 is enabled |

Confidence alone does not establish identity: name-only matches can also score 100.
An identifier match requires `matched_on: "ico"` or `"id"`; name/alias matches require
human review even at confidence 100.
In `get_dd_report`, `sanctions_match` carries `match_strength` (`strong` / `possible` /
`weak-name-only`) and `dob_status` (`match` / `mismatch` / `list_missing` / `subject_missing`);
the listing id for `get_listing` is `${source}:${list_id}`.
An empty or stale list yields `⚠️ Sankční seznam NENÍ načten … NELZE potvrdit čisto`
with `isError: true` → **not verified**, not "clean".

## adis — VAT payer reliability (`@czagents/adis`)

| Tool | Inputs | Returns | Tier |
|---|---|---|---|
| `check_dph_payer` | `ico` or `dic` | `reliability` (**ANO = unreliable**, NE = reliable, NENALEZEN = not in VAT registry), `subject_type`, `subject_name`, `address`, `unreliable_since`, `tax_office`, `accounts[]` (`formatted`, `publikovan_od`, `publikovan_do`) | Free |
| `check_bulk_dph_payer` | `icos[]` or `dics[]` (≤100) | Reliability + accounts per subject (no name/address) | Free |
| `list_unreliable_payers` | — | Full list (50–100 MB) | Free — never for a single check |

Careful: in ADIS `ANO` means "yes, unreliable" (nespolehlivý plátce = ANO).

## eu-registry — non-Czech registries (`@czagents/eu-registry`)

| Tool | Inputs | Returns | Tier |
|---|---|---|---|
| `search_company` | `name`, `country?` (ISO-2 or name), `limit` (1–20, default 10) | `companies[]`, `total_results`, optional `coverage_preview` for gated countries | Free (hosted coverage policy may gate some countries — see `tier_required` `dimension: "coverage"`) |
| `get_company` | `id` (national ID), `country` | Company record | Free (same note) |
| `lookup_company_by_vat` | `vat` (with ISO-2 prefix) | VIES validity + name/address where disclosed | Free |

Countries: GB, SK, PL, NL, IT, AT, ES, BE, LT, DE, FR, NO, DK, FI, EE, SE. ID types per
country (from code): gb CRN, sk IČO, pl KRS, lt JAR code, nl/it/at/es/be VAT, de LEI,
fr SIREN, no org. number, dk CVR, fi Business ID, ee registry code, se 10-digit org. number.
Czech companies are **not** served here.

## ddplus — DD+ paid extension (hosted only, closed source)

Requires a paid subscription; individual tools require Compliance or Agency.
`bulk_lookup` and `check_bulk_ico_insolvency` require Agency (not Compliance). See
https://cz-agents.dev/pricing. The tool list below matches `DDPLUS_CAPABILITIES` in
`packages/shared/src/entitlements/resolver.ts` (returned as `available_in_tier` on
depth-gated `tier_required` errors). **Purposes are inferred from the names only;
parameters and outputs are TODO** (not documented in the public repo). Never call these
on the free tier.

| Tool | Purpose (inferred from name) |
|---|---|
| `get_dd_report_plus` | Extended DD report |
| `assess_person_risk` | Risk assessment of a person in a company role |
| `detect_nominee_director_rich` | Extended nominee-director detection |
| `detect_phoenix_rich` | Extended phoenix-company detection |
| `detect_address_crowding_rich` | Extended address-crowding / virtual-office detection |
| `get_risk_timeline_rich` | Enriched risk timeline |
| `analyze_linked_entities_risk` | Risk of linked entities |
| `get_or_ownership` | Ownership from the commercial register (OR) |
| `get_ownership_network_full` | Full ownership network |
| `get_eu_parent` | EU / international parent |
| `monitor_company`, `list_monitored_companies` | Company monitoring |
| `add_to_watchlist`, `remove_from_watchlist`, `list_watchlist`, `scan_watchlist` | Watchlist management and scan |
| `bulk_lookup` | Bulk company lookup |
| `check_bulk_ico_insolvency` | Bulk ISIR insolvency check |

## Limits and error shapes (from code)

| Mechanism | Where | What the client sees |
|---|---|---|
| Anonymous daily tool-call quota (`HOSTED_TOOL_QUOTAS=1`) | `shared/src/billing/hostedToolQuota.ts` | **100 tool calls / day / IP** (legacy mode; ladder mode: 50/day + 250/30 days for lookup servers, 100/day for dd). Exceeded → HTTP 429 `{"error":"anonymous_quota_exceeded","message",…,"registration_url","pricing_url"}` + `Retry-After`; headers `X-Anonymous-Quota-Limit/Remaining/Reset` |
| Registered lookup allowance | same | HTTP 429 `registered_quota_exceeded` + `pricing_url` |
| Per-IP burst limiter | `shared/src/rateLimit.ts` | HTTP 429 `rate_limit_exceeded`, `retry_after_seconds`, `upgrade_url`. Code default 30/min (dd) or 60/min; `docker-compose.yml` sets 600/min |
| Distinct-company / distinct-query daily cap (`ICO_DAILY_CAP`, `QUERY_DAILY_CAP`) | `shared/src/icoTracker.ts` | Tool result `isError: true`, text `Denní free limit vyčerpán (N firem/den) … → https://app.cz-agents.dev/cena`. Off by default in code; `docker-compose.yml` sets 60 firms and 25 name queries per day per /24 |
| Tier gate (legacy) | `dd/src/server.ts` `requireTier` | `{"error":"tier_required","tool","tier_needed","current_tier","message","action":"inform_user_and_stop","retry_after_upgrade":true,"upgrade_url":"https://app.cz-agents.dev/cena"}`, `isError: true` |
| Tier gate (hosted entitlements, when `HOSTED_GEO_TIER_ENFORCEMENT` ≠ off) | `shared/src/entitlements/resolver.ts` | `{"error":"tier_required","dimension":"depth"\|"coverage","required_tier":"ddplus"\|"extended","country","upgrade_url","message","available_in_tier":[…]}` |
| Paid usage | `dd/src/http.ts` | `quota_exceeded`, `credits_exhausted`, `trial_expired`, `usage_limit_exceeded`, `policy_unavailable` |

The "~30 calls/day" figure appears in the repo only as the ARES **REST sandbox** note
("Get free API key (30 calls/day)"), not as an MCP limit. Which env values production
actually runs with is not visible from the repo — **TODO: confirm with the operator.**
