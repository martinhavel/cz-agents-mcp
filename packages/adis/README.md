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

### `check_dph_payer`

Use it to check one Czech subject’s VAT-payer reliability, registered accounts, and tax-registry details by IČO or DIČ. Do not use it for a supplier portfolio; use the bulk tool instead.

```json
{"ico":"26168685"}
```

### `check_bulk_dph_payer`

Use it to screen a list of Czech IČOs and/or DIČs in one request, up to the service limit. Do not use it when full name and address details for one subject are required; use `check_dph_payer`.

```json
{"dics":["CZ26168685","CZ00006947"]}
```

### `list_unreliable_payers`

Use it for a scheduled mirror or local-data refresh of all currently unreliable VAT payers. Do not use it for an ad-hoc lookup: the source list is 50–100 MB and may contain tens of thousands of entries; use `check_dph_payer` instead.

```json
{}
```

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

ADIS itself is a free public service. The hosted endpoint at `https://adis.cz-agents.dev/mcp` is rate-limited per IP. Higher limits and commercial use: https://cz-agents.dev/pricing.html

## License

MIT — see [LICENSE](https://github.com/martinhavel/cz-agents-mcp/blob/main/LICENSE)
