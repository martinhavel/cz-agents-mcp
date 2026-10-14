---
name: cz-company-due-diligence
description: Use before any cz-agents MCP call (dd, ares, isir, sanctions, adis, eu-registry). Czech/EU company due diligence – IČO, KYC/AML, sankce, insolvence, plátce DPH, statutáři, skutečný majitel, prověrka protistrany.
when_to_use: Any check of a Czech or EU company or counterparty – IČO/DIČ lookup, supplier/vendor onboarding, counterparty or customer screening, sanctions/AML screening of a company or its directors, insolvency (ISIR), VAT payer reliability (ADIS), owners/UBO, phoenix company, nominee/white-horse director (bílý kůň), shell company, virtual office, foreign parent. CZ: prověř firmu, prověrka, kontrola obchodního partnera, sankční seznam, jednatel, insolvenční rejstřík, spolehlivý plátce.
---

# Czech / EU company due diligence (cz-agents MCP)

Use the cz-agents MCP servers to screen a company (counterparty, supplier, customer,
acquisition target) against Czech and EU public sources, and write a sourced,
time-stamped report a human can act on. Works fully on the **free tier**.

> **Positioning — say this in every report:** this is a screening *tool*, not an audit
> or a legal opinion, and comes with no warranty. The output is input for a human
> decision. Registry data is valid only as of the query time.

## When to use

- The user gives a Czech **IČO** (8 digits; 7-digit forms are zero-padded) or a Czech/EU
  company name and wants to know if it is safe to deal with.
- Requests like: *prověř firmu / dodavatele / protistranu*, *KYC*, *AML*, *due diligence*,
  *je na sankčním seznamu?*, *má insolvenci?*, *je spolehlivý plátce DPH?*,
  *kdo je statutár / jednatel?*, *kdo firmu vlastní / skutečný majitel?*,
  *check this supplier*, *sanctions screening*, *vendor onboarding*, *counterparty check*.
- A non-Czech EU company (SK, PL, DE, GB, …) or a foreign parent of a Czech company.

## When NOT to use

- Accounting, tax or legal advice (how to book, whether to pay VAT, contract wording).
  You may report a VAT-payer *status*; do not advise on tax treatment.
- Screening or profiling private individuals outside their role in a company
  (e.g. "find everything about Jan Novák"). Persons are in scope only as statutory
  members / owners of the company being checked.
- Credit scoring, financial statements, or collections — these tools do not provide them.
- Real-estate distress data, FX rates or payment QR codes — other cz-agents servers, not this skill.

## Servers you need

Free servers (hosted, anonymous): `dd`, `ares`, `isir`, `sanctions`, `adis`, `eu-registry`.
Setup: [references/install.md](references/install.md). Tool catalogue with inputs,
outputs and tiers: [references/tools.md](references/tools.md).
Tool names below are given as `server.tool`; your client may show them prefixed
(e.g. `mcp__dd__get_dd_report`). If a server is not connected, say which one and
continue with what is available.

## Procedure

Follow [references/workflows.md](references/workflows.md) for the full decision tree.
Short version:

### 1. Identify the subject — never guess

- **IČO given** → use it as-is. If a tool answers `IČO checksum failed … (MOD11)` or
  `Invalid IČO format`, tell the user the IČO is invalid and ask them to re-check it.
  Do not "fix" digits yourself, and do not retry on another server — all of them run
  the same MOD11 check.
- **Only a name** → `ares.search_companies({ query, city? })` once. Show up to ~5
  candidates (name, IČO, address) and **ask the user to confirm** which one. Do not
  continue until they confirm, unless exactly one candidate matches name *and* the
  city/address the user gave — then say which one you picked and why.
- **Foreign company** → step 4.

### 2. Quick screen (1–2 calls)

1. `dd.get_dd_report({ ico, depth: "basic" })` — one call returns ARES facts, statutory
   body with a per-member EU+OFAC sanctions check, company sanctions check, ADIS VAT
   reliability and published accounts, red flags and a 0–100 score.
   - If the user wants *only a score*, call `dd.get_risk_score({ ico })` instead —
     never both (it is a subset of the report).
   - Do **not** request `depth: "full"` on the free tier; it is DD+ (paid).
2. `isir.check_ico_insolvency({ ico })` — the free DD report does **not** check ISIR
   (it lists ISIR as "not checked"). Call this whenever the user asks for a full check,
   insolvency, or before payment/credit decisions.

### 3. Escalate only on findings (or on explicit request)

| Finding / request | Next call (free) | Notes |
|---|---|---|
| Sanctions hit on company or member | `sanctions.get_listing({ id })` | Compare DOB / nationality / programs. See "Sanctions" below. |
| Report shows VAT `checked: false` / ADIS error, or user wants to verify an invoice bank account | `adis.check_dph_payer({ ico })` | Accounts are listed under `accounts[].formatted`. |
| User asks about owners / skutečný majitel | `dd.get_owners({ ico })` | VR shareholders only. Real UBO (ESM) is not public — say so. |
| Statutory member flagged, or user asks about personal insolvency of a director | `isir.search_person_insolvency({ name, dob })` | Only for that member, only with DOB from the report. |
| Recent renames / address changes matter | `ares.get_history({ ico })` | |
| Suspected virtual office / "address hotel" | `ares.search_by_address({ street, city, psc })` | Report the total the tool returns; do not turn it into your own risk rating. |
| Nominee director, phoenix pattern, risk timeline, address crowding, EU parent, statutory chain | `dd.detect_nominee_director` / `dd.detect_phoenix` / `dd.get_risk_timeline` / `dd.detect_address_crowding` / `dd.get_eu_parent` / `dd.get_statutory_chain` | **Paid** (Compliance / Agency). On the free tier they return `tier_required` — see "Tiers". |

### 4. Foreign / EU subject

- `eu-registry.search_company({ name, country })` → let the user confirm the hit →
  `eu-registry.get_company({ id, country })`. With an EU VAT number:
  `eu-registry.lookup_company_by_vat({ vat })`.
- Sanctions: `sanctions.search_entity({ name, country })`.
- `dd.get_eu_dd_report` and `dd.get_eu_parent` are paid; on the free tier use the
  `eu-registry` + `sanctions` path above. A foreign parent of a Czech company is usually
  visible as a legal-entity owner in `dd.get_owners`; look that owner up in `eu-registry`.
- Czech subjects are **not** served by `eu-registry`; use `ares`/`dd`.

### 5. Ongoing monitoring — only if the user asks

- `dd.watch_entity({ ico })` (or `ares.watch_entity`) returns an onboarding URL.
  It does **not** start monitoring by itself (`persisted: false`). Give the user the URL;
  never open it, fill in data, or accept GDPR consent on their behalf.
- Watchlists (`add_to_watchlist`, `monitor_company`, `scan_watchlist`, …) are DD+ (paid).

## Be frugal with calls

Free hosted usage is limited per IP (see "Limits"). Therefore:

- Plan the calls before making them; a standard check is **2 calls** (step 2).
- Never call the same tool with the same arguments twice in a session — reuse the result.
- Never call paid (Compliance+/Agency+/DD+) tools in parallel. Call at most one, and only
  if the user asked for that analysis; if it returns `tier_required`, skip the rest.
- If the report marks a source unavailable, you may try that one source **once** via its
  single-source server (e.g. `adis.check_dph_payer` for ADIS). If that fails too, stop
  and report it as not verified. Do not re-run checks that already succeeded (e.g. the
  company sanctions check is already inside `get_dd_report`).
- Do not fan out across all tools "just in case". Escalate only per step 3.
- Do not loop over many IČOs one by one for bulk work; say that bulk screening is a
  paid feature (`bulk_lookup`, `check_bulk_ico_insolvency` in DD+) or ask the user to
  narrow the list. `adis.check_bulk_dph_payer` (≤100 subjects, one call) is fine for a
  VAT-only bulk check.
- Never call `adis.list_unreliable_payers` (50–100 MB dump) or `isir.poll_isir_events`
  for a single-company check.

## Tiers, limits and errors

**`tier_required`** (tool result with `isError: true`). Two shapes exist:
- `{ "error": "tier_required", "tool", "tier_needed", "current_tier", "message", "action": "inform_user_and_stop", "upgrade_url" }`
- `{ "error": "tier_required", "dimension": "depth"|"coverage", "required_tier", "country", "message", "upgrade_url", "available_in_tier": [...] }`

Then: **stop calling that tool** (and do not try sibling paid tools — assume the same
tier blocks them), show the user the `message` and `upgrade_url` verbatim, list the
check under "Not verified", and continue with the free tools. Retry only if the user
says they upgraded.

**Limits / quota** (HTTP 429 or tool-level message):
`anonymous_quota_exceeded`, `registered_quota_exceeded`, `rate_limit_exceeded`,
`quota_exceeded`, `credits_exhausted`, `trial_expired`, `usage_limit_exceeded`, or a
text starting `Denní free limit vyčerpán`. Then: stop calling that server, tell the user
which limit was hit, show any `Retry-After` / `retry_after_seconds` and the URL in the
response (`registration_url`, `pricing_url` or `upgrade_url`), and deliver a partial
report from what you already have. Do not retry in a loop.

**Source not checked** — treat as *unknown*, never as *clean*:
- `unavailable_sources` / `⚠ ČÁSTEČNĚ PROVĚŘENO` / flags like `ARES_UNAVAILABLE` in the
  dd output. A score of `0/100 low` with unavailable sources is **not** "low risk".
- ISIR text containing `NEPROBĚHL` / `ISIR není nakonfigurován`.
- Sanctions text `Sankční seznam NENÍ načten` / `NELZE potvrdit čisto`.
- `vr_not_configured`, `vr_base_unavailable`, `adis_unavailable`, `adis_not_configured`.
- Errors such as `fetch failed` / `ISIR query failed` / `ADIS query failed`.
- A **locally run** sanctions server whose DB was never refreshed: the published
  `@czagents/sanctions@0.1.5` then answers "no match" without a warning. If the user runs
  sanctions locally, say the result is valid only if the list DB is refreshed
  (see [install.md](references/install.md)).

## Guardrails (mandatory)

1. **Every claim has a source.** Each finding names the tool that returned it and the
   query time (`retrieved_at` if the tool gives one, otherwise the time you called it,
   ISO 8601 with timezone). No source → don't state it.
2. **Do not infer or embellish.** Report what the tools returned. "No record in ISIR at
   query time" is not "financially healthy".
3. **Scores come from the tools.** Quote `risk_score.value` / `level` and the red flags
   as returned. Do not recompute, re-weight, average or invent a score of your own.
4. **Sanctions: match ≠ confirmed.** A name match (`match_strength: possible` or
   `weak-name-only`, `dob_status` ≠ `match`) is a **possible match requiring human
   review**, never "the person is sanctioned". Use "confirmed" only when the tool
   reports an exact identifier match (e.g. `matched_on: "ico"` / confidence 100) — and
   even then recommend verification against the official list.
5. **GDPR / data minimisation.** Mention natural persons only in their company role and
   only the data needed (name, role, since; birth year rather than full date unless
   needed to disambiguate a sanctions/insolvency match). Do not run person searches
   (`dd.person_companies`, `isir.search_person_insolvency`, `sanctions.search_person`)
   for people unrelated to the subject company, and do not build profiles of individuals.
6. **UBO.** The Czech register of beneficial owners (ESM) is not public; these tools
   cannot confirm a *skutečný majitel*. `get_owners` shows VR shareholders — label it
   "indicated ownership from the public register", not "UBO".
7. **Time-bound.** State that results reflect the registries at the query time.
8. **Never** put API keys or tokens into files, prompts or reports.

## Output

Write the report using [references/report-template.md](references/report-template.md):
risk summary (tool score + top flags), findings table with source and query time,
**"Not verified"** section (paid tools, unavailable sources, skipped checks), recommended
next steps, and the disclaimer. Answer in the user's language (Czech or English).

## Česky — stručně

Postup: (1) ověř IČO, jinak `ares.search_companies` a nech uživatele potvrdit;
(2) `dd.get_dd_report` (basic) + `isir.check_ico_insolvency`; (3) další nástroje jen
podle nálezů; (4) zahraniční firmy přes `eu-registry` + `sanctions.search_entity`;
(5) hlídání jen na přání (`watch_entity` vrací odkaz, uživatel dokončí sám).
Při `tier_required` přestaň volat daný nástroj, ukaž `message` + `upgrade_url`
a pokračuj zdarma. Shoda jména na sankčním seznamu ≠ potvrzený zásah. Výsledek je
podklad pro rozhodnutí člověka, ne audit ani právní posouzení, bez záruky.

## Evaluation

Test prompts and expected behaviour: [evals/prompts.md](evals/prompts.md).
