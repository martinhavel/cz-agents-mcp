/**
 * REST cesta placená přes x402: `POST /v1/sanctions/rescreen`.
 *
 * # Proč samostatný soubor a samostatný endpoint
 *
 * `rescreenPortfolio` je **nové plnění, ne zpoplatnění stávajícího**. Žádný
 * z pěti dnešních nástrojů se nemění a nic, co dnes kdokoli dostane, se
 * nezhoršuje — to je tvrdá podmínka zadání a je na ni akceptační test.
 *
 * Když je x402 vypnuté, tenhle endpoint **neexistuje** (vrací 404 jako každá
 * jiná neznámá cesta). Nedává se zdarma a nedává se rozbitý; prostě tu není.
 *
 * # Tvar 402 odpovědi
 *
 * x402 v2 nese payment requirements v hlavičce `PAYMENT-REQUIRED` (base64 JSON),
 * ne v těle — *„Response bodies are a server implementation concern. All x402
 * protocol information is communicated through headers."* Tělo se posílá jen
 * jako lidsky čitelná nápověda, protokol na něm nestojí.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { createRestRateLimiter } from '@czagents/shared';
import type { SanctionsDb } from './db.js';
import { rescreenPortfolio, RescreenValidationError, type PortfolioSubject } from './rescreen.js';
import type { X402Gate } from '@czagents/shared/x402';

const RESOURCE_PATH = '/v1/sanctions/rescreen';
const MAX_BODY_BYTES = 256_000; // portfolio o 500 subjektech se do toho vejde

/** Hlavičky x402 v2. `X-PAYMENT` patří v1 a nepoužívá se. */
const HEADER_REQUIRED = 'PAYMENT-REQUIRED';
const HEADER_SIGNATURE = 'PAYMENT-SIGNATURE';
const HEADER_RESPONSE = 'PAYMENT-RESPONSE';

const b64 = (value: unknown): string => Buffer.from(JSON.stringify(value), 'utf8').toString('base64');

function decodeHeader(raw: string | string[] | undefined): unknown {
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (!value) return null;
  try {
    return JSON.parse(Buffer.from(value, 'base64').toString('utf8'));
  } catch {
    return null;
  }
}

/**
 * @returns `true` když cestu obsloužil (i chybou), `false` když mu nepatří —
 *   volající pak pokračuje na ostatní REST cesty.
 */
export async function handleX402Rescreen(
  req: IncomingMessage,
  res: ServerResponse,
  deps: { db: SanctionsDb; gate: X402Gate | null; limiter: ReturnType<typeof createRestRateLimiter> },
): Promise<boolean> {
  if (!req.url) return false;
  const url = new URL(req.url, 'http://localhost');
  if (url.pathname !== RESOURCE_PATH) return false;

  // Vypnuté x402 = endpoint neexistuje. Ne 402, ne 503 — 404, protože z pohledu
  // volajícího tu opravdu nic není.
  if (!deps.gate) {
    json(res, 404, { error: 'not_found', message: 'Endpoint not found.' });
    return true;
  }

  // Neautentizovaný útočník by jinak mohl bez limitu opakovat 402 nabídky
  // a nechat parsovat 256 KB tělo na request — tohle je stejný limiter jako
  // u `/v1/*`, sdílený přes klientskou IP (viz http.ts).
  if (!deps.limiter(req, res)) return true;

  if (req.method !== 'POST') {
    json(res, 405, { error: 'method_not_allowed', message: 'Use POST with a JSON body.' });
    return true;
  }

  let body: { subjects?: PortfolioSubject[]; since?: string | number; source?: string };
  try {
    body = JSON.parse(await readBody(req, MAX_BODY_BYTES)) as typeof body;
  } catch {
    json(res, 400, { error: 'invalid_request', message: 'A JSON body is required.' });
    return true;
  }

  const sinceMs = parseSince(body.since);
  if (sinceMs === null) {
    json(res, 400, { error: 'invalid_request', message: '`since` must be an ISO date or epoch ms.' });
    return true;
  }

  // Zdroj se odvozuje ze VSTUPU, ne z toho, co tvrdí platba. Kdyby se bral
  // z payloadu, dal by se koupit levný zdroj a předložit u drahého — to je
  // přesně to, co má resource binding zavřít.
  const resource = resourceIdFor(body.subjects?.length ?? 0, sinceMs);

  const paymentPayload = decodeHeader(req.headers[HEADER_SIGNATURE.toLowerCase()]);
  if (!paymentPayload) {
    // `resourceInfo` je objekt s `url`, ne řetězec — klient ho vrací beze změny
    // zpátky a naše kontrola bindingu se váže právě na něj.
    const { requirements, resource: resourceInfo } = deps.gate.offer(resource);
    res.setHeader(HEADER_REQUIRED, b64({ x402Version: 2, resource: resourceInfo, accepts: [requirements] }));
    json(res, 402, {
      error: 'payment_required',
      message: 'This resource is paid. See the PAYMENT-REQUIRED header for terms.',
      resource,
    });
    return true;
  }

  const outcome = await deps.gate.redeem({ payload: paymentPayload, expectedResource: resource });
  if (!outcome.released) {
    // Platba neprošla → data se NEVYDAJÍ. Znovu se posílá i nabídka, aby měl
    // volající co splnit, aniž by musel začínat od začátku.
    const { requirements, resource: resourceInfo } = deps.gate.offer(resource);
    res.setHeader(HEADER_REQUIRED, b64({ x402Version: 2, resource: resourceInfo, accepts: [requirements] }));
    json(res, 402, { error: 'payment_failed', code: outcome.code, message: outcome.reason, resource });
    return true;
  }

  // Teprve tady, po úspěšném settlementu, se sáhne na data.
  try {
    const result = rescreenPortfolio({ db: deps.db }, {
      subjects: body.subjects ?? [],
      sinceMs,
      source: body.source as never,
    });
    if (outcome.settlement) {
      res.setHeader(HEADER_RESPONSE, b64(outcome.settlement));
    }
    json(res, 200, result);
  } catch (error) {
    if (error instanceof RescreenValidationError) {
      // Zaplaceno a vstup je vadný: vrací se 400 s vysvětlením. Platba se
      // nevrací automaticky — je to případ pro ruční řešení a patří do reportu.
      json(res, 400, { error: 'invalid_request', message: error.message, paid: true });
      return true;
    }
    console.error('[sanctions] x402 rescreen error:', error);
    json(res, 500, { error: 'upstream_error', message: 'Request failed.', paid: true });
  }
  return true;
}

/**
 * Identifikátor zdroje pro resource binding. Váže platbu na **rozsah** práce,
 * ne na konkrétní jména — do identifikátoru se nesmí dostat obsah portfolia,
 * protože jde do logu i do payloadu.
 */
export function resourceIdFor(subjectCount: number, sinceMs: number): string {
  return `sanctions:rescreen:n=${subjectCount}:since=${sinceMs}`;
}

function parseSince(value: string | number | undefined): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string') {
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

function json(res: ServerResponse, status: number, body: unknown): void {
  if (res.headersSent) return;
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

function readBody(req: IncomingMessage, maxBytes: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > maxBytes) {
        reject(new Error('body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}
