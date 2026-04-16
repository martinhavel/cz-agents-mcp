# cz-agents-mcp

Model Context Protocol servers for Czech government & business data.
Give your AI agent native access to ARES, ČNB, and more.

**Landing page:** [cz-agents.dev](https://cz-agents.dev)

## Available servers

| Package | Source | Status |
|---|---|---|
| [`@czagents/ares`](./packages/ares) | ARES — Czech Business Register | ✅ live |
| [`@czagents/cnb`](./packages/cnb) | ČNB — daily FX rates | ✅ live |
| `@czagents/isir` | ISIR — Czech insolvency register | 🚧 future |

## Quick start

### Claude Desktop / Cursor (stdio)

```json
{
  "mcpServers": {
    "ares": { "command": "npx", "args": ["-y", "@czagents/ares"] },
    "cnb":  { "command": "npx", "args": ["-y", "@czagents/cnb"] }
  }
}
```

### Remote / Streamable HTTP

```json
{
  "mcpServers": {
    "ares": { "url": "https://ares.cz-agents.dev/mcp" },
    "cnb":  { "url": "https://cnb.cz-agents.dev/mcp" }
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

## Further reading

- [Building MCP servers for a country that isn't in the dataset](https://dev.to/martinhavel/building-mcp-servers-for-a-country-that-isnt-in-the-dataset-czech-gov-apis-1lo8) — design rationale, gotchas (MOD11, ARES Swagger bugs), and how this pattern adapts MCP to non-English locales.

## License

MIT © Martin Havel — see [LICENSE](./LICENSE)
