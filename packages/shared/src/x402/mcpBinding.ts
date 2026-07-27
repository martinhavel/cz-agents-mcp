/**
 * MCP transport binding pro x402 v2.
 *
 * # Proč se to nedělá HTTP statusem
 *
 * MCP jede přes JSON-RPC a odpověď má HTTP 200 i tehdy, když nástroj selže.
 * Poslat 402 by tedy shodilo celý transport, ne jedno volání. Specifikace to
 * řeší vlastní signalizací a **HTTP status u MCP vůbec nepoužívá**:
 *
 * - platba se vyžaduje jako tool result `isError: true`, kde je `PaymentRequired`
 *   **současně** v `structuredContent` i v `content[0].text`
 *   (spec: *„Servers MUST provide the `PaymentRequired` in both formats"*)
 * - klient posílá platbu v `_meta["x402/payment"]` request parametru
 * - server vrací settlement v `_meta["x402/payment-response"]`
 *
 * Že `_meta` projde oběma směry přes StreamableHTTP v našem SDK, není domněnka
 * — ověřeno spuštěným spikem (spikem proti in-process MCP klientovi), ne čtením typů.
 *
 * # Proč vazbu píšeme sami, když existuje `@x402/mcp`
 *
 * Ten balíček by výdej dat rozhodoval za nás. Sedm kontrol včetně resource
 * bindingu ale musí běžet u nás — facilitátor ani cizí knihovna nevědí, co
 * servírujeme. `@x402/mcp` se používá na **klientské** straně E2E testu, kde je
 * nezávislost naopak žádoucí: vlastní klient proti vlastnímu serveru dokazuje
 * shodu se specifikací, ne interoperabilitu.
 */
import type { X402Gate } from './gate.js';

export const MCP_PAYMENT_META_KEY = 'x402/payment';
export const MCP_PAYMENT_RESPONSE_META_KEY = 'x402/payment-response';

/** Tvar, na kterém se shodne MCP SDK i tenhle modul, bez závislosti na SDK typech. */
interface ToolResult {
  content: Array<{ type: string; [k: string]: unknown }>;
  structuredContent?: unknown;
  isError?: boolean;
  _meta?: Record<string, unknown>;
}

interface ToolExtra {
  _meta?: Record<string, unknown>;
  [k: string]: unknown;
}

/**
 * Obalí handler placeného nástroje.
 *
 * @param resourceOf Odvodí identifikátor zdroje z argumentů volání. **Musí být
 *   deterministický a nesmí obsahovat citlivá data** — jde do payloadu i do logu.
 */
export function withX402Tool<A>(
  gate: X402Gate,
  resourceOf: (args: A) => string,
  handler: (args: A, extra?: ToolExtra) => Promise<ToolResult> | ToolResult,
): (args: A, extra?: ToolExtra) => Promise<ToolResult> {
  return async (args, extra) => {
    const resource = resourceOf(args);
    const payment = readPaymentFromMeta(args, extra);

    if (!payment) {
      const { requirements, resource: resourceInfo } = gate.offer(resource);
      return paymentRequiredResult({ x402Version: 2, resource: resourceInfo, accepts: [requirements] });
    }

    const outcome = await gate.redeem({ payload: payment, expectedResource: resource });
    if (!outcome.released) {
      // Neúspěšná platba se vrací jako další výzva k zaplacení, ne jako obecná
      // chyba — klient se z ní musí dozvědět, co má splnit.
      const { requirements, resource: resourceInfo } = gate.offer(resource);
      return paymentRequiredResult(
        { x402Version: 2, resource: resourceInfo, accepts: [requirements], error: outcome.code },
        outcome.reason,
      );
    }

    // Teprve tady, po úspěšném settlementu, se sáhne na data.
    const result = await handler(args, extra);
    if (outcome.settlement) {
      result._meta = { ...result._meta, [MCP_PAYMENT_RESPONSE_META_KEY]: outcome.settlement };
    }
    return result;
  };
}

/**
 * Platba může přijít v `_meta` requestu nebo v `extra._meta` — SDK ji podle
 * verze podává na jednom z těch dvou míst. Čte se obojí, aby vazba nezávisela
 * na detailu, který se může změnit s verzí SDK.
 */
function readPaymentFromMeta(args: unknown, extra?: ToolExtra): unknown {
  const fromExtra = extra?._meta?.[MCP_PAYMENT_META_KEY];
  if (fromExtra) return fromExtra;
  const fromArgs = (args as { _meta?: Record<string, unknown> } | null)?._meta?.[MCP_PAYMENT_META_KEY];
  return fromArgs ?? null;
}

/**
 * Signál „zaplať" podle specifikace.
 *
 * `PaymentRequired` je v `structuredContent` **i** v `content[0].text`, a to
 * z téhož objektu — spec to vyžaduje v obou formátech a rozejít je by znamenalo,
 * že klient čtoucí text dostane něco jiného než klient čtoucí strukturu.
 */
function paymentRequiredResult(paymentRequired: unknown, humanNote?: string): ToolResult {
  const serialized = JSON.stringify(paymentRequired);
  const content: ToolResult['content'] = [{ type: 'text', text: serialized }];
  if (humanNote) content.push({ type: 'text', text: humanNote });
  return { isError: true, content, structuredContent: paymentRequired };
}
