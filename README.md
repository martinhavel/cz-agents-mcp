# cz-agents-mcp

Model Context Protocol servers for Czech government & business data.
Give your AI agent native access to ARES, ČNB, ISIR, and more.

## Available servers

| Package | Source | Status |
|---|---|---|
| [`@czagents/ares`](./packages/ares) | ARES — Czech Business Register (company lookup by IČO) | ✅ v0.1.0 |
| `@czagents/cnb` | ČNB — daily FX rates | 🚧 planned |
| `@czagents/isir` | ISIR — Czech insolvency register | 🚧 planned |

## Quick start

### Claude Desktop / Cursor (stdio)

```json
{
  "mcpServers": {
    "ares": {
      "command": "npx",
      "args": ["-y", "@czagents/ares"]
    }
  }
}
```

### Remote / Streamable HTTP

```json
{
  "mcpServers": {
    "ares": { "url": "https://ares.cz-agents.dev/mcp" }
  }
}
```

## Example tools (ARES)

- `lookup_by_ico({ ico: "27074358" })` — full company record
- `search_companies({ query: "Tech", city: "Praha", pocet: 20 })`
- `get_bank_accounts({ ico: "27074358" })` — DPH-published accounts
- `get_history({ ico: "27074358" })` — previous names, address changes

## License

MIT © Martin Havel
