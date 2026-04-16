import { HttpClient, TtlCache } from '@czagents/shared';

/**
 * ČNB FX rates client.
 *
 * Daily exchange rate list ("Kurzy devizového trhu") is published every
 * business day at ~14:30 CET. Weekends/holidays = previous business day.
 *
 * Source text format (tab-separated, UTF-8):
 *   <header line>
 *   <date line — e.g., "16.04.2026 #73">
 *   země|měna|množství|kód|kurz
 *   Austrálie|dolar|1|AUD|14,132
 *   ...
 *
 * Two endpoints:
 *   - daily.txt              — 31 major currencies (EUR, USD, GBP, …)
 *   - kurzy-ostatnich-men... — ~120 exotic currencies, monthly
 */

const CNB_DAILY =
  'https://www.cnb.cz/cs/financni-trhy/devizovy-trh/kurzy-devizoveho-trhu/kurzy-devizoveho-trhu/denni_kurz.txt';

export interface CnbRate {
  country: string;
  currencyName: string;
  amount: number; // usually 1, sometimes 100 (HUF, JPY…)
  code: string; // ISO 4217 (EUR, USD, GBP, …)
  rate: number; // CZK per `amount` units of currency
}

export interface CnbRateSheet {
  date: string; // YYYY-MM-DD
  sequence: number; // daily sheet number (e.g., 73)
  rates: CnbRate[];
}

export class CnbClient {
  private readonly http: HttpClient;
  // ČNB publishes rates once per business day at ~14:30 CET — cache 10 min is safe
  private readonly sheetCache = new TtlCache<string, CnbRateSheet>({
    ttlMs: 10 * 60 * 1000,
    maxSize: 500,
  });

  constructor() {
    this.http = new HttpClient({
      baseUrl: 'https://www.cnb.cz',
      timeoutMs: 10_000,
      retries: 2,
    });
  }

  /**
   * Fetch daily FX rates. If `date` is given (YYYY-MM-DD), fetch historical;
   * else returns today's (or last business day's) rates. Cached 10 min.
   */
  async getDailyRates(date?: string): Promise<CnbRateSheet> {
    const cacheKey = date ?? 'today';
    return this.sheetCache.memoize(cacheKey, async () => {
      const url = date ? `${CNB_DAILY}?date=${formatCzDate(date)}` : CNB_DAILY;
      const text = await this.http.getText(url);
      return parseCnbDailyText(text);
    });
  }

  /** Convert amount between currencies using latest rates. */
  async convert(
    amount: number,
    from: string,
    to: string,
    date?: string,
  ): Promise<{ amount: number; from: string; to: string; rate: number; sheetDate: string }> {
    const sheet = await this.getDailyRates(date);
    const fromUpper = from.toUpperCase();
    const toUpper = to.toUpperCase();

    const getCzkRate = (code: string): number => {
      if (code === 'CZK') return 1;
      const r = sheet.rates.find((x) => x.code === code);
      if (!r) throw new Error(`Currency ${code} not found in ČNB sheet (${sheet.date})`);
      return r.rate / r.amount; // CZK per 1 unit
    };

    const fromCzk = getCzkRate(fromUpper);
    const toCzk = getCzkRate(toUpper);
    const rate = fromCzk / toCzk;
    return {
      amount: Math.round(amount * rate * 10_000) / 10_000,
      from: fromUpper,
      to: toUpper,
      rate: Math.round(rate * 100_000) / 100_000,
      sheetDate: sheet.date,
    };
  }
}

// ---- Parser ----

/**
 * Parse ČNB daily .txt format:
 *   "16.04.2026 #73\nzemě|měna|množství|kód|kurz\nAustrálie|dolar|1|AUD|14,132\n..."
 */
export function parseCnbDailyText(text: string): CnbRateSheet {
  const lines = text.split(/\r?\n/).filter((l) => l.trim().length > 0);
  if (lines.length < 2) {
    throw new Error('ČNB response too short (no data rows)');
  }

  // First line: "DD.MM.YYYY #N"
  const headerRe = /^(\d{2})\.(\d{2})\.(\d{4})\s*#(\d+)/;
  const m = headerRe.exec(lines[0]!);
  if (!m) throw new Error(`Unexpected ČNB header: "${lines[0]}"`);
  const [, dd, mm, yyyy, seq] = m;
  const date = `${yyyy}-${mm}-${dd}`;
  const sequence = Number(seq);

  // Skip header row (země|měna|množství|kód|kurz)
  const rates: CnbRate[] = [];
  for (let i = 2; i < lines.length; i++) {
    const parts = lines[i]!.split('|');
    if (parts.length < 5) continue;
    const [country, currencyName, amountStr, code, rateStr] = parts;
    rates.push({
      country: country!.trim(),
      currencyName: currencyName!.trim(),
      amount: Number(amountStr!.trim()),
      code: code!.trim().toUpperCase(),
      rate: Number(rateStr!.trim().replace(',', '.')),
    });
  }

  return { date, sequence, rates };
}

/** Convert YYYY-MM-DD → DD.MM.YYYY for ČNB query param. */
function formatCzDate(iso: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  if (!m) throw new Error(`Date must be YYYY-MM-DD, got "${iso}"`);
  return `${m[3]}.${m[2]}.${m[1]}`;
}
