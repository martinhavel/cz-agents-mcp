# @czagents/payqr

**European Payment QR — an MCP server for generating and reading payment QR codes.**

Deterministically create **SPAYD** (Czech/Slovak) and **EPC / GiroCode** (SEPA) payment QR codes,
plus plain-text, Wi-Fi and vCard QR codes — and decode QR codes back from an image.

Free, MIT-licensed, **no AI and no paid API**. Everything is computed locally; nothing is sent anywhere.

> 💡 Prefer a browser? The same engine runs as a free web app at **<https://qr.cz-agents.dev>** —
> type the details or drop a payment screenshot / QR code, all client-side.

## Why

Copying an IBAN, amount and variable symbol from a broker deposit instruction (Revolut, Trading 212,
XTB, an invoice…) into a banking app by hand is slow and error-prone — one wrong digit sends money to
the wrong account. This server turns those details into a scannable payment QR your bank app reads
directly, and can also read an existing payment QR back into structured fields.

## Install

Add it to your MCP client (e.g. Claude Desktop `claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "payqr": {
      "command": "npx",
      "args": ["-y", "@czagents/payqr"]
    }
  }
}
```

Or run directly:

```bash
npx -y @czagents/payqr        # stdio transport
```

## Tools

| Tool | Description |
|------|-------------|
| `qr_payment` | European payment QR. Auto-selects **SPAYD** for CZ/SK IBANs and **EPC/GiroCode** for other SEPA IBANs. IBAN validated with the mod-97 checksum. |
| `qr_text` | QR code containing plain text. |
| `qr_wifi` | Wi-Fi network QR code (WPA/WEP/open, hidden SSID supported). |
| `qr_vcard` | vCard 3.0 contact QR code. |
| `qr_read` | Decode a QR code from a base64 PNG/JPEG image and classify its content. |

Each generating tool returns both a rendered QR **image** and a **text** block with the encoded
payload, the chosen standard and any warnings — so clients display the QR natively and you can verify
exactly what it encodes.

### Payment-from-image workflow

When you paste a screenshot or photo of payment details, the assistant reads the IBAN, amount,
currency, recipient and reference from the image and calls `qr_payment`. **Before showing the QR it
echoes the extracted fields back for you to verify against the source** — a misread digit sends real
money to the wrong place — and only then presents the code.

## Standards

- **SPAYD** (`SPD*1.0*…`) — the Czech/Slovak "QR Platba" string format read by Czech and Slovak bank apps.
- **EPC / GiroCode** (`BCD`…) — the SEPA Credit Transfer QR standard (EPC069-12), EUR-only, widely
  used in Germany, Austria and across the euro area. Requires a recipient name.

## Privacy

No telemetry, no network calls for QR generation, no AI. Pure local computation.

## License

MIT © cz-agents
