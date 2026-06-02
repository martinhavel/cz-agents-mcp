# @czagents/adis

Czech VAT payer reliability check (ADIS / "nespolehlivý plátce DPH") — verify whether a VAT payer is flagged as unreliable and retrieve officially registered bank accounts for a given DIČ. Critical for VAT-deduction risk and pre-payment verification. Direct from the Czech tax administration.

## Install

```bash
npm install -g @czagents/adis
```

## Usage with Claude Desktop

```json
{
  "mcpServers": {
    "adis": {
      "command": "npx",
      "args": ["-y", "@czagents/adis"],
      "env": {
        "ADIS_SOAP_ENABLED": "1"
      }
    }
  }
}
```

## Tools

- `check_dph_payer` — full reliability check for a single subject (by IČO or DIČ). Returns status, subject type, name, address, transparent bank accounts, and `unreliable-since` date when applicable.
- `check_bulk_dph_payer` — batch up to 100 subjects in one ADIS request (lighter response: status + accounts only).
- `list_unreliable_payers` — full list of currently unreliable Czech VAT payers from ADIS. Large response (50–100 MB) — intended for daily mirroring rather than ad-hoc lookup.

### Status meanings

| Status | Meaning |
|---|---|
| `ANO` | Subject is currently flagged as an **unreliable** VAT payer (nespolehlivý plátce / nespolehlivá osoba). |
| `NE` | Subject is a VAT payer in good standing. |
| `NENALEZEN` | Subject not found in ADIS — typically not a VAT payer. |

Example prompts:

> Check VAT-payer reliability for IČO 12345678.

> Among these 30 invoice issuers, list any that are currently unreliable VAT payers.

## Self-host

Source: https://github.com/martinhavel/cz-agents-mcp

```bash
git clone https://github.com/martinhavel/cz-agents-mcp
cd cz-agents-mcp
npm install
npm run build
ADIS_SOAP_ENABLED=1 node packages/adis/dist/index.js
```

## Free tier & pricing

ADIS itself is a free public service. The hosted endpoint at `https://adis.cz-agents.dev/mcp` is rate-limited per IP. Higher limits and commercial use: https://cz-agents.dev/pricing

## License

MIT — see [LICENSE](https://github.com/martinhavel/cz-agents-mcp/blob/main/LICENSE)
