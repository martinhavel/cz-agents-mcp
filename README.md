# cz-agents-mcp

[![CI](https://github.com/martinhavel/cz-agents-mcp/actions/workflows/ci.yml/badge.svg)](https://github.com/martinhavel/cz-agents-mcp/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](./LICENSE)

Model Context Protocol servers for Czech government & business data.
Give your AI agent native access to ARES, ČNB, and more.

**Landing page:** [cz-agents.dev](https://cz-agents.dev)

## Available servers

| Package | Source | Status |
|---|---|---|
| [`@czagents/ares`](./packages/ares) | ARES — Czech Business Register | ✅ live |
| [`@czagents/cnb`](./packages/cnb) | ČNB — daily FX rates | ✅ live |
| [`@czagents/sanctions`](./packages/sanctions) | EU + OFAC sanctions screening (KYC/AML) | 🧪 beta |
| [`@czagents/dd`](./packages/dd) | Due-diligence aggregator (ARES + sanctions + ISIR) | 🧪 beta |
| `@czagents/isir` | ISIR — Czech insolvency register | 🚧 future |

## Quick start

### Claude Desktop / Cursor (stdio)

```json
{
  "mcpServers": {
    "ares":      { "command": "npx", "args": ["-y", "@czagents/ares"] },
    "cnb":       { "command": "npx", "args": ["-y", "@czagents/cnb"] },
    "sanctions": { "command": "npx", "args": ["-y", "@czagents/sanctions"], "env": { "SANCTIONS_DB": "/path/to/sanctions.db" } },
    "dd":        { "command": "npx", "args": ["-y", "@czagents/dd"], "env": { "SANCTIONS_DB": "/path/to/sanctions.db" } }
  }
}
```

### Remote / Streamable HTTP

```json
{
  "mcpServers": {
    "ares":      { "url": "https://ares.cz-agents.dev/mcp" },
    "cnb":       { "url": "https://cnb.cz-agents.dev/mcp" },
    "sanctions": { "url": "https://sanctions.cz-agents.dev/mcp" },
    "dd":        { "url": "https://dd.cz-agents.dev/mcp" }
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

### `@czagents/dd` (3 tools)

- `get_dd_report({ ico, depth })` — unified ARES + sanctions + ISIR report with risk score
- `get_risk_score({ ico })` — fast 0–100 score + top red flags
- `get_statutory_chain({ ico, max_depth })` — UBO / shell-company tree walk

## Further reading

- [Building MCP servers for a country that isn't in the dataset](https://dev.to/martinhavel/building-mcp-servers-for-a-country-that-isnt-in-the-dataset-czech-gov-apis-1lo8) — design rationale, gotchas (MOD11, ARES Swagger bugs), and how this pattern adapts MCP to non-English locales.

## License

MIT © Martin Havel — see [LICENSE](./LICENSE)
