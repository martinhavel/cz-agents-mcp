# cz-agents-mcp

[![CI](https://github.com/martinhavel/cz-agents-mcp/actions/workflows/ci.yml/badge.svg)](https://github.com/martinhavel/cz-agents-mcp/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](./LICENSE)
[![MCP Registry](https://img.shields.io/badge/MCP_Registry-listed-blue)](https://registry.modelcontextprotocol.io/v0/servers?search=cz-agents)
[![Glama](https://img.shields.io/badge/glama.ai-listed-success)](https://glama.ai/mcp/servers/lgs0fwjrl8)

Model Context Protocol servers for Czech & EU government and business data. Native access to ARES (company registry), ČNB (FX rates), ADIS (VAT-payer status), ISIR (insolvency), EU + OFAC sanctions screening, and EU business registries (GB/SK/PL/NL/DE/FR) — plus a unified due-diligence aggregator that combines them into risk scoring and statutory-chain (UBO) analysis.

> **Want a hosted, production-ready version?**
> [cz-agents.dev](https://cz-agents.dev) — managed API with a 14-day free trial (no credit card).
> Adds higher quotas, nominee detection, risk timeline, address crowding, watchlist monitoring, and a web compliance dashboard.
> Your self-hosted config keeps working after upgrade — same endpoints, same token format.

### No-code web app

Don't want to wire an MCP client? The same data is available as a web application:

- [Company verification by IČO (ověření firmy)](https://app.cz-agents.dev/overeni-firmy)
- [AML company check (AML kontrola firmy)](https://app.cz-agents.dev/aml-kontrola-firmy)
- [Sanctions list screening (kontrola sankčních seznamů)](https://app.cz-agents.dev/kontrola-sankcnich-seznamu)
- [Business partner due diligence (prověření obchodního partnera)](https://app.cz-agents.dev/provereni-obchodniho-partnera)
- [Company change monitoring (monitoring změn ve firmě)](https://app.cz-agents.dev/monitoring-zmen-ve-firme)
- Case study: [company due diligence with an AI agent — 20 minutes → 30 seconds](https://cz-agents.dev/case-study/company-due-diligence-with-ai-agent/)

**Landing page:** [cz-agents.dev](https://cz-agents.dev) · **Listed in:** [official MCP Registry](https://registry.modelcontextprotocol.io) under DNS-verified namespace `dev.cz-agents/*`

## Available servers

| Package | Source | Status |
|---|---|---|
| [`@czagents/ares`](./packages/ares) | ARES — Czech Business Register | ✅ live |
| [`@czagents/cnb`](./packages/cnb) | ČNB — daily FX rates | ✅ live |
| [`@czagents/sanctions`](./packages/sanctions) | EU + OFAC sanctions screening (KYC/AML) | ✅ live |
| [`@czagents/isir`](./packages/isir) | ISIR — Czech insolvency register | ✅ live |
| [`@czagents/adis`](./packages/adis) | ADIS — unreliable VAT payer (nespolehlivý plátce DPH) + transparent accounts | ✅ live |
| [`@czagents/dd`](./packages/dd) | Due-diligence aggregator (ARES + sanctions + ISIR + ADIS + statutory chain) | ✅ live |
| [`@czagents/realestate`](./packages/realestate) | Czech distress real estate intelligence (ISIR sales + portál dražeb) | ✅ live (v0.1) |
| [`@czagents/eu-registry`](./packages/eu-registry) | EU business registries — GB (Companies House), SK, PL, NL, DE, FR via GLEIF/LEI | ✅ live |
| [`@czagents/payqr`](./packages/payqr) | Payment QR codes (SPAYD / EPC-GiroCode) — bonus utility | ✅ live |

### Premium tier — closed source

| Server | What it adds | Where |
|---|---|---|
| `dev.cz-agents/ddplus` | 8-indicator nominee director detection (cross-DB), phoenix recidiva, enriched risk timeline with AI narrative, recursive linked-entities risk analysis (depth 1-3), shell-firm address crowding with provider detection, daily watchlist monitoring with email digest | Hosted-only at `ddplus.cz-agents.dev/mcp` — see [pricing](https://cz-agents.dev/pricing.html) |

## Quick start

### Claude Desktop / Cursor (stdio)

```json
{
  "mcpServers": {
    "ares":      { "command": "npx", "args": ["-y", "@czagents/ares"] },
    "cnb":       { "command": "npx", "args": ["-y", "@czagents/cnb"] },
    "sanctions": { "command": "npx", "args": ["-y", "@czagents/sanctions"], "env": { "SANCTIONS_DB": "/path/to/sanctions.db" } },
    "isir":      { "command": "npx", "args": ["-y", "@czagents/isir"], "env": { "ISIR_SOAP_ENABLED": "1" } },
    "adis":      { "command": "npx", "args": ["-y", "@czagents/adis"], "env": { "ADIS_SOAP_ENABLED": "1" } },
    "dd":          { "command": "npx", "args": ["-y", "@czagents/dd"], "env": { "SANCTIONS_DB": "/path/to/sanctions.db", "ADIS_SOAP_ENABLED": "1" } },
    "eu-registry": { "command": "npx", "args": ["-y", "@czagents/eu-registry"] },
    "payqr":       { "command": "npx", "args": ["-y", "@czagents/payqr"] }
  }
}
```

### Remote / Streamable HTTP

```json
{
  "mcpServers": {
    "ares":        { "url": "https://ares.cz-agents.dev/mcp" },
    "cnb":         { "url": "https://cnb.cz-agents.dev/mcp" },
    "sanctions":   { "url": "https://sanctions.cz-agents.dev/mcp" },
    "isir":        { "url": "https://isir.cz-agents.dev/mcp" },
    "adis":        { "url": "https://adis.cz-agents.dev/mcp" },
    "dd":          { "url": "https://dd.cz-agents.dev/mcp" },
    "eu-registry": { "url": "https://eu-registry.cz-agents.dev/mcp" },
    "payqr":       { "url": "https://payqr.cz-agents.dev/mcp" }
  }
}
```

## Tools

### `@czagents/ares` (9 tools)

- `lookup_by_ico({ ico })` — full company record
- `search_companies({ query, city, street, psc, nace, pocet })` — combined search
- `search_by_address({ street, city, psc })` — all companies at an address
- `search_by_nace({ nace, city })` — by CZ-NACE activity code
- `get_statutaries({ ico })` — current statutory body (for due diligence)
- `validate_dic({ dic })` — DIČ format + MOD11 checksum
- `check_vat_payer({ ico })` — VAT registration + transparent accounts
- `get_bank_accounts({ ico })` — DPH-published accounts
- `get_history({ ico })` — previous names, address changes

### `@czagents/cnb` (3 tools)

- `get_rates({ date? })` — full daily FX sheet
- `convert({ amount, from, to, date? })` — CZK-crossed conversion
- `get_rate({ code, date? })` — single currency rate

### `@czagents/sanctions` (5 tools)

- `search_person({ name, dob?, nationality?, threshold? })` — fuzzy KYC screen against EU + OFAC
- `search_entity({ name, country?, threshold? })` — entity / company screen
- `check_ico({ ico, name? })` — direct lookup of a Czech IČO on sanctions lists
- `get_listing({ id })` — full record by `${source}:${id}`
- `list_recent_updates({ since, source? })` — daily monitoring (added/removed/modified)

### `@czagents/isir` (3 tools)

- `check_ico_insolvency({ ico })` — direct lookup of a Czech IČO in the insolvency register
- `search_person_insolvency({ ico?, rc?, dob?, firstname?, surname? })` — find a person by IČO, birth number, or name + DOB
- `poll_isir_events({ since })` — append-only event feed for daily monitoring

### `@czagents/adis` (3 tools)

- `check_dph_payer({ ico OR dic })` — full reliability check via ADIS V2: status (ANO/NE/NENALEZEN), subject type, name, address, transparent bank accounts (§ 96a ZDPH), unreliable-since date
- `check_bulk_dph_payer({ icos[] OR dics[] })` — batch up to 100 subjects (lighter response, status + accounts only)
- `list_unreliable_payers()` — full list of currently unreliable payers (50–100 MB, intended for daily mirroring)

### `@czagents/dd` (3 tools)

- `get_dd_report({ ico, depth })` — unified ARES + sanctions + ISIR report with risk score
- `get_risk_score({ ico })` — fast 0–100 score + top red flags
- `get_statutory_chain({ ico, max_depth })` — UBO / shell-company tree walk

### `@czagents/eu-registry` (3 tools)

- `get_eu_company({ country, id })` — company record from GB (Companies House), SK (ORSR), PL (KRS), NL/DE/FR (GLEIF/LEI), SIRENE
- `get_eu_parent({ ico })` — find EU parent/group via ARES → GLEIF LEI matching with confidence scoring
- `get_eu_dd_report({ country, id })` — EU DD report: company facts + EU + OFAC sanctions check

## What this is good for

A toolkit for compliance, KYC/AML, accounting and cross-border checks over Czech & EU registries:

- **VAT & invoicing** — verify VAT-payer status (ADIS) and convert at official ČNB FX rates before booking.
- **Counterparty screening** — ARES identity, EU + OFAC sanctions, ISIR insolvency.
- **Due diligence (flagship)** — the `@czagents/dd` aggregator combines the above into a risk score, statutory-chain / UBO walk, and EU-parent lookup.
- **Cross-border** — company lookups across GB / SK / PL / NL / DE / FR registries (`@czagents/eu-registry`).

Use a single-source server when you need just one dataset; use the due-diligence aggregator for combined, scored output.

Example prompts the aggregator handles well:

- **KYC pre-invoice** — *"Before we send a 350 000 Kč invoice to IČO 11122234, flag any insolvency, sanctions, unreliable-VAT-payer status, or nominee-director red flags."*
- **Vendor onboarding** — *"Run KYC on this prospective supplier and tell me if anything looks off. Use the full statutory chain."*
- **M&A pre-due-diligence** — *"Generate a DD report on the acquisition target and walk the statutory body two levels deep — flag any insolvent firms in the network."*

## Score & validation

[![Glama Score](https://glama.ai/mcp/servers/martinhavel/cz-agents-mcp/badges/score.svg)](https://glama.ai/mcp/servers/martinhavel/cz-agents-mcp)

A/A/A on Glama (quality / security / license), claimed and maintained.
Listed in the [official MCP registry](https://registry.modelcontextprotocol.io)
under DNS-verified namespace `dev.cz-agents/*`.

## Further reading

- [Building MCP servers for a country that isn't in the dataset](https://dev.to/martinhavel/building-mcp-servers-for-a-country-that-isnt-in-the-dataset-czech-gov-apis-1lo8) — design rationale, gotchas (MOD11, ARES Swagger bugs), and how this pattern adapts MCP to non-English locales.

## License

MIT © Martin Havel — see [LICENSE](./LICENSE)
