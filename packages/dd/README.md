# @czagents/dd

Czech & EU due diligence in one call — company facts, insolvency (ISIR), EU+OFAC sanctions, VAT reliability, risk scoring (0-100), and statutory chain. EU coverage via GLEIF/LEI. Official state registries only, no Cribis/Bisnode reselling.

## Install

```bash
npm install -g @czagents/dd
```

## Usage with Claude Desktop

```json
{
  "mcpServers": {
    "dd": {
      "command": "npx",
      "args": ["-y", "@czagents/dd"],
      "env": {
        "SANCTIONS_DB": "/absolute/path/to/sanctions.db",
        "ADIS_SOAP_ENABLED": "1"
      }
    }
  }
}
```

## Tools

Each example is an MCP tool-call argument object.

- `person_companies` — finds Czech registry companies connected to a person, preserving separate same-name registry identities. Do not use it to identify someone from a full birth date or to infer a person from a partial name. Example: `{"name":"Jan Novak","birth_year":1975}`.
- `get_owners` — returns direct and upstream active Czech company owners, with recursive company ownership. Do not use it as an official beneficial-owner (ESM) record or for personal addresses/full birth dates. Example: `{"ico":"12345678","max_depth":3}`.
- `get_dd_report` — full Czech company due-diligence report: facts, statutory body, sanctions checks, and risk flags. Do not use it for a non-Czech entity or when only a quick screening score is needed. Example: `{"ico":"12345678","depth":"full"}`.
- `watch_entity` — starts the human onboarding flow for monitoring one Czech company and returns its next step; it does not persist monitoring yet. Do not use it to complete consent, open the returned URL, or assume a watch is active. Example: `{"ico":"12345678"}`.
- `get_risk_score` — a fast 0–100 score, level, and top risk flags for a Czech IČO. Do not use it when you need the underlying company facts or full evidence. Example: `{"ico":"12345678"}`.
- `get_statutory_chain` *(Agency tier+)* — follows related statutory bodies using surname heuristics. Do not use it as a true UBO source, especially for common surnames or large public-company boards. Example: `{"ico":"12345678","max_depth":2}`.
- `detect_nominee_director` *(Compliance tier+)* — checks surface “white horse” indicators such as age outliers, multi-board membership, and recent appointments. Do not use it as a complete eight-indicator forensic assessment; use the richer ddplus tool for that. Example: `{"ico":"12345678"}`.
- `detect_phoenix` *(Compliance tier+)* — checks surface indicators of a phoenix-company pattern using ARES and ISIR data. Do not use it as proof of asset transfer or a complete phoenix investigation. Example: `{"ico":"12345678"}`.
- `get_risk_timeline` *(Compliance tier+)* — produces a chronological risk timeline for formation, appointments, insolvency, sanctions, and VAT events. Do not use it when a full enriched cross-entity narrative is required. Example: `{"ico":"12345678"}`.
- `detect_address_crowding` *(Compliance tier+)* — measures registered-address crowding and classifies possible virtual-office or shell-firm-hotel risk. Do not use it as evidence that every company at a shared address is illegitimate. Example: `{"ico":"12345678"}`.
- `get_eu_dd_report` *(Compliance tier+)* — performs GLEIF-based international entity due diligence plus EU/OFAC sanctions screening. Do not use it for SMEs that may have no LEI, or as a substitute for national registry/UBO data. Example: `{"identifier":"W38RGI023J3WT1HWRP32"}`.
- `get_eu_parent` *(Compliance tier+)* — looks for an international parent of a Czech company through ARES and GLEIF. Do not use it to conclude that no parent exists when the entity has no LEI coverage. Example: `{"ico":"12345678"}`.

## What `get_dd_report` returns

Sources: ARES (company facts), VR (statutory body), EU + OFAC sanctions lists, ADIS (VAT payer, reliability, published bank accounts). `depth: "full"` (DD+, paid) adds ISIR insolvency for the company and its statutory members, their prior insolvent companies, and a virtual-address check.

Free hosted limit: `depth: "basic"`, 100 tool calls per day per IP, no sign-in.

Each call returns a markdown summary plus the full JSON report. Trimmed example (`depth: "basic"`, test fixture data):

```text
**Test Co. s.r.o.** · IČO 12345679 — ⚠ ČÁSTEČNĚ PROVĚŘENO. Riziko 0/100 (nízké).
3 zdroje: ARES · EU+OFAC sankce · ADIS — ISIR nešlo ověřit (neproběhla kontrola).
Statutární orgán: 1 jednatel · sankční shoda: žádná.
```

```json
{
  "ico": "12345679",
  "basic_only": true,
  "company": { "name": "Test Co. s.r.o.", "legal_form": "112", "address": "Testovací 1, Praha", "registered_on": "2010-01-01", "found": true },
  "vat": { "is_payer": true, "dic": "CZ12345679", "bank_accounts": ["123/0100"], "reliability": "NE" },
  "statutory_body": [{ "name": "Jan Test", "role": "jednatel", "is_person": true }],
  "sanctions": { "any_statutory_match": false },
  "red_flags": [],
  "risk_score": { "value": 0, "level": "low" }
}
```

Full sample report: [CZ](https://app.cz-agents.dev/vzorovy-report) · [EN](https://cz-agents.dev/sample-report/)

Example prompts:

> Generate a DD report for IČO 12345678.

> Run KYC on Acme Imports s.r.o. and tell me if anything looks off — walk the statutory chain two levels.

## Tiers

| Tier | What you get |
|---|---|
| **Free** | `get_dd_report`, `get_risk_score`, `get_statutory_chain`. Rate-limited per IP. |
| **Compliance** | Adds `detect_nominee_director` and `get_risk_timeline`. Higher rate limits, batch endpoints. |
| **Agency** | Multi-tenant (white-label), API key per analyst, even higher limits, REST API + webhooks. |

Tier details and pricing: https://cz-agents.dev/pricing.html

## Self-host

Source: https://github.com/martinhavel/cz-agents-mcp

```bash
git clone https://github.com/martinhavel/cz-agents-mcp
cd cz-agents-mcp
npm install
npm run build
SANCTIONS_DB=$PWD/sanctions.db ADIS_SOAP_ENABLED=1 node packages/dd/dist/index.js
```

A self-hosted instance runs all checks against the public upstream APIs and your own copy of `sanctions.db` (built via `@czagents/sanctions`).

## License

MIT — see [LICENSE](https://github.com/martinhavel/cz-agents-mcp/blob/main/LICENSE)
