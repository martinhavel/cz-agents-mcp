# Workflows and decision tree

Goal: the fewest calls that answer the user's actual question, with every finding sourced.
Tool names are `server.tool`; see [tools.md](tools.md) for inputs and outputs.

## Decision tree

```
START
 │
 ├─ Is the subject Czech?
 │   ├─ IČO given ───────────────────────────────┐
 │   ├─ name only → ares.search_companies         │
 │   │     ├─ 0 hits → ask for IČO / spelling    │
 │   │     ├─ 1 hit matching name + city → state choice, continue
 │   │     └─ several → list ≤5 (name, IČO, address), WAIT for user
 │   └─ IČO invalid (MOD11 error) → ask user to re-check, STOP
 │                                                │
 │   QUICK SCREEN  ◄──────────────────────────────┘
 │     1. dd.get_dd_report {ico, depth:"basic"}   (or dd.get_risk_score if only a score is wanted)
 │     2. isir.check_ico_insolvency {ico}         (full check / insolvency / payment decision)
 │
 │   Read the result:
 │     ├─ unavailable_sources / ČÁSTEČNĚ PROVĚŘENO → mark those sources "not verified"
 │     ├─ company.found = false (and ARES available) → report "IČO not found in ARES", STOP
 │     ├─ company.dissolved_on set → report dissolution (major finding)
 │     ├─ sanctions.company_match or any member sanctions_match → SANCTIONS branch
 │     ├─ vat.reliability = "ANO" → unreliable VAT payer (§ 109 ZDPH joint liability risk) – report
 │     ├─ vat.checked = false → adis.check_dph_payer {ico}
 │     ├─ ISIR active proceeding → report spisová značka, phase, start date
 │     └─ user asked about owners → dd.get_owners {ico} (+ ESM note)
 │
 ├─ Foreign subject → EU branch
 └─ "keep watching it" → MONITORING branch
```

## Branches

### Sanctions

1. From the report take `source`, `list_id`, `confidence`, `match_strength`, `dob_status`.
2. `sanctions.get_listing({ id: "<source>:<list_id>" })` — once per distinct listing.
3. Classify, quoting the tool's fields:
   - **Confirmed (identifier match)** — `matched_on` is an identifier (`ico`/`id`) with
     confidence 100. Still recommend verification against the official list.
   - **Possible match — human review required** — name/alias match; DOB matches or is missing.
   - **Likely false positive — human review recommended** — `dob_status: "mismatch"`;
     say why (DOB differs) but do not dismiss it yourself.
4. Never write "X is sanctioned" for a name-only match.

### Statutory-member insolvency (on request or red flag)

`isir.search_person_insolvency({ name, dob })` for the specific member, using the DOB
from the report (`datumNarozeni`). Without DOB, say that results for common names are
unreliable. Report the match count and spisová značka only.

### Ownership / UBO

- `dd.get_owners({ ico })` — VR shareholder tree (free). Hosted only; via npx it needs a
  VR database (`vr_not_configured` otherwise). Fallback: `ares.get_owners({ ico })` —
  raw VR owners of this one company.
- Always add: the ESM (evidence skutečných majitelů) is non-public since 17 Dec 2025; the
  obliged person must obtain UBO from ESM themselves (`dd` report field `esm_onramp`).
- Most a.s. do not publish shareholders — an empty list is "not published", not "no owners".

### Red-flag patterns (nominee / phoenix / address crowding / timeline)

- On the free tier these `dd` tools return `tier_required`. Call **at most one** of them
  and only if the user asked for that analysis or the report raised a matching flag.
  After the first `tier_required`, do not call the others; list them under "Not verified".
- Free partial alternatives (facts only, no scoring):
  - address: `ares.search_by_address({ street, city, psc })` → report the total count;
  - history: `ares.get_history({ ico })` → renames / address moves.

### EU / foreign subject

1. With EU VAT: `eu-registry.lookup_company_by_vat({ vat })`.
2. Otherwise `eu-registry.search_company({ name, country })` → user confirms →
   `eu-registry.get_company({ id, country })`.
3. `sanctions.search_entity({ name, country })`.
4. Report coverage limits (e.g. LT without address/officers, DE via GLEIF/LEI only).
5. `dd.get_eu_dd_report` is Compliance+; do not call on the free tier unless the user
   explicitly wants to try it (then expect `tier_required`).

### Czech company with a foreign (e.g. Slovak) parent

1. Quick screen of the Czech company.
2. `dd.get_owners({ ico })` → a legal-entity owner without Czech IČO and a foreign address.
3. `eu-registry.get_company({ id: <SK IČO>, country: "sk" })` or `search_company`.
4. `sanctions.search_entity({ name, country: "SK" })`.
5. `dd.get_eu_parent` (GLEIF parent) is Compliance+ → expect `tier_required` on free.

### Monitoring (only on request)

`dd.watch_entity({ ico })` → hand the `next_step.url` to the user. State clearly that
monitoring is **not active** until they finish onboarding (`persisted: false`). Watchlist
tools are DD+.

### Bulk (many IČOs)

- VAT only: `adis.check_bulk_dph_payer({ icos })` (≤100, one call).
- Anything else: explain the free per-IP limits and that bulk DD is DD+ (`bulk_lookup`,
  `check_bulk_ico_insolvency`); offer to check the top few the user prioritises.

## Typical scenarios → call budget

| Scenario | Calls |
|---|---|
| "Prověř IČO X" (standard) | `dd.get_dd_report` + `isir.check_ico_insolvency` = 2 |
| "Je spolehlivý plátce DPH?" | `adis.check_dph_payer` = 1 |
| "Má insolvenci?" | `isir.check_ico_insolvency` = 1 |
| "Sankce na statutáře" | `dd.get_dd_report` (+ `sanctions.get_listing` per hit) = 1+ |
| "Kdo firmu vlastní?" | `dd.get_owners` (or `ares.get_owners`) = 1 |
| Name only | `ares.search_companies` + confirmation + standard = 3 |
| Foreign company | `eu-registry.*` + `sanctions.search_entity` = 2–3 |
| Quick score only | `dd.get_risk_score` = 1 |

## Error handling summary

| Signal | Action |
|---|---|
| `tier_required` | Stop that tool (and sibling paid tools); show `message` + `upgrade_url`; continue free |
| HTTP 429 / `*_quota_exceeded` / `rate_limit_exceeded` / `Denní free limit vyčerpán` | Stop that server; show limit, reset time, URL; deliver partial report |
| `unavailable_sources`, `ČÁSTEČNĚ PROVĚŘENO`, `NEPROBĚHL`, `NENÍ načten` | Mark source "not verified"; never present as clean |
| MOD11 / format error | Ask user to re-check IČO |
| Tool not connected | Say which server is missing; point to `install.md` |
