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

- `get_dd_report` — full DD report for an IČO: company facts, statutory body with per-member sanctions check, transparent risk score with all triggered red flags.
- `get_risk_score` — lightweight 0-100 score + risk level + top red flags. Faster when you only need a yes/no/maybe screen.
- `get_statutory_chain` — surname-based heuristic walk through statutory bodies of related companies. Useful for shell-company unwinding in small s.r.o. with rare surnames. **Not** a true UBO source — for actual beneficial ownership use the ESM (evidence skutečných majitelů, separate registry).
- `detect_nominee_director` *(Compliance tier+)* — detect "white horse" / nominee director patterns across 8 indicators: residence at municipal office, multi-board membership, personal insolvency, prior bankrupt companies, recent appointment, shared flagged address, HQ matching residence, etc. Returns indicator-by-indicator breakdown for compliance audit.
- `get_risk_timeline` *(Compliance tier+)* — chronologically sorted lifecycle timeline (formation, statutory changes, insolvency, sanctions matches, VAT reliability flips). For audit narrative and "story so far" reports.

Example prompts:

> Generate a DD report for IČO 12345678.

> Run KYC on Acme Imports s.r.o. and tell me if anything looks off — walk the statutory chain two levels.

## Tiers

| Tier | What you get |
|---|---|
| **Free** | `get_dd_report`, `get_risk_score`, `get_statutory_chain`. Rate-limited per IP. |
| **Compliance** | Adds `detect_nominee_director` and `get_risk_timeline`. Higher rate limits, batch endpoints. |
| **Agency** | Multi-tenant (white-label), API key per analyst, even higher limits, REST API + webhooks. |

Tier details and pricing: https://cz-agents.dev/pricing

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
