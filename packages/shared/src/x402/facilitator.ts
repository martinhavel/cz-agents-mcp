/**
 * Klient facilitátoru x402 v2 (`POST /verify`, `POST /settle`, `GET /supported`).
 *
 * Rozhraní `Facilitator` je to, co zná aplikace — ne konkrétní třída. Díky tomu
 * jde facilitátora (x402.org na testnetu, CDP na mainnetu, nebo cokoli jiného,
 * co splní tři metody) vyměnit beze změny volajícího kódu, jen změnou URL a
 * auth módu v konfiguraci.
 *
 * Datové typy (`PaymentRequirements`, `PaymentPayload`, `VerifyResponse`,
 * `SettleResponse`, `SupportedResponse`) jsou opsané ze skutečných `.d.ts`
 * balíčku `@x402/core@2.19.0` (rozbaleno do
 * `@x402/core` (`dist/cjs`, typové definice),
 * řádky ~1205–1269), NE importované odtamtud — `@x402/core` je volitelná peer
 * závislost a fáze 1 nesmí vyžadovat, aby byla nainstalovaná. Strukturálně
 * jsou proto shodné se skutečným SDK; až fáze 2/3 balíček zavedou jako reálnou
 * dependency, tahle rozhraní by měla jít nahradit importem beze změny volajících.
 *
 * Metody `Facilitator` se jmenují `supported/verify/settle` podle zadání fáze 1
 * (`build-spec-faze1.md`), zatímco skutečný SDK má `getSupported/verify/settle`
 * — jediný rozdíl je název té jedné metody, těla jsou shodná.
 */

/** CAIP-2 identifikátor sítě, např. `eip155:8453`. */
export type Network = `${string}:${string}`;

export interface PaymentRequirements {
  scheme: string;
  network: Network;
  asset: string;
  amount: string;
  payTo: string;
  maxTimeoutSeconds: number;
  extra: Record<string, unknown>;
}

export interface ResourceInfo {
  url: string;
  description?: string;
  mimeType?: string;
  serviceName?: string;
  tags?: string[];
  iconUrl?: string;
}

export interface PaymentPayload {
  x402Version: number;
  resource?: ResourceInfo;
  accepted: PaymentRequirements;
  payload: Record<string, unknown>;
  extensions?: Record<string, unknown>;
}

export interface VerifyResponse {
  isValid: boolean;
  invalidReason?: string;
  invalidMessage?: string;
  payer?: string;
  extensions?: Record<string, unknown>;
  extra?: Record<string, unknown>;
}

export interface SettleResponse {
  success: boolean;
  errorReason?: string;
  errorMessage?: string;
  payer?: string;
  transaction: string;
  network: Network;
  /** Skutečně vypořádaná částka v atomických jednotkách, pokud se liší od autorizované. */
  amount?: string;
  extensions?: Record<string, unknown>;
  extra?: Record<string, unknown>;
}

export interface SupportedKind {
  x402Version: number;
  scheme: string;
  network: Network;
  extra?: Record<string, unknown>;
}

export interface SupportedResponse {
  kinds: SupportedKind[];
  extensions: string[];
  signers: Record<string, string[]>;
}

/** Rozhraní, přes které aplikace facilitátora zná. Ne přes typ implementace. */
export interface Facilitator {
  supported(): Promise<SupportedResponse>;
  verify(paymentPayload: PaymentPayload, paymentRequirements: PaymentRequirements): Promise<VerifyResponse>;
  settle(paymentPayload: PaymentPayload, paymentRequirements: PaymentRequirements): Promise<SettleResponse>;
}

export type FacilitatorPhase = 'supported' | 'verify' | 'settle';
export type FacilitatorAuthMode = 'none' | 'cdp';

/**
 * Chyba facilitátoru — síťová, timeout, nebo neočekávaná HTTP odpověď. Volající
 * (resource server) na ni musí reagovat tak, že se data NEVYDAJÍ; tahle třída
 * sama o sobě nic nezadržuje, jen nese dost informace, aby to šlo udělat a
 * zalogovat KDE to selhalo (fáze čítače `cz_agents_x402_facilitator_errors_total`).
 */
export class FacilitatorError extends Error {
  constructor(
    message: string,
    public readonly phase: FacilitatorPhase,
    public override readonly cause?: unknown,
  ) {
    super(message);
    this.name = 'FacilitatorError';
  }
}

export interface HttpFacilitatorOptions {
  /** Base URL facilitátoru, např. `https://x402.org/facilitator` nebo CDP endpoint. */
  url: string;
  /**
   * `'none'` = žádná auth (x402.org na testnetu). `'cdp'` = Coinbase Developer
   * Platform, který vyžaduje podepsané hlavičky i pro testnet. Fáze 1 CDP
   * podpis sama neimplementuje — `createAuthHeaders` je hook, kterým to dodá
   * volající (fáze 2/3, nebo `config.ts`), tahle třída jen hlavičky přimíchá.
   */
  authMode?: FacilitatorAuthMode;
  /** Povinné, pokud `authMode === 'cdp'`. Vrací hlavičky přidané ke každému requestu. */
  createAuthHeaders?: () => Record<string, string> | Promise<Record<string, string>>;
  /** Timeout na KAŽDÉ volání (supported/verify/settle) zvlášť. Default 10 s. */
  timeoutMs?: number;
  /** Injektovatelné pro testy; default `globalThis.fetch`. */
  fetchImpl?: typeof fetch;
}

/**
 * HTTP implementace `Facilitator`. Facilitátor sám ověří podpis a provede
 * převod; tahle třída jen přenáší požadavek/odpověď a hlídá timeout. Žádná
 * z resource-server kontrol (`checks.ts`) tu neběží — to je záměrně jinde.
 */
export class HttpFacilitator implements Facilitator {
  private readonly url: string;
  private readonly authMode: FacilitatorAuthMode;
  private readonly createAuthHeaders?: () => Record<string, string> | Promise<Record<string, string>>;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;

  constructor(opts: HttpFacilitatorOptions) {
    if (!opts.url || opts.url.trim().length === 0) {
      throw new Error('HttpFacilitator: url je povinné');
    }
    if (opts.authMode === 'cdp' && !opts.createAuthHeaders) {
      throw new Error("HttpFacilitator: authMode 'cdp' vyžaduje createAuthHeaders");
    }
    this.url = opts.url.replace(/\/$/, '');
    this.authMode = opts.authMode ?? 'none';
    this.createAuthHeaders = opts.createAuthHeaders;
    this.timeoutMs = opts.timeoutMs ?? 10_000;
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  async supported(): Promise<SupportedResponse> {
    return this.request<SupportedResponse>('supported', 'GET', '/supported');
  }

  async verify(paymentPayload: PaymentPayload, paymentRequirements: PaymentRequirements): Promise<VerifyResponse> {
    return this.request<VerifyResponse>('verify', 'POST', '/verify', {
      x402Version: paymentPayload.x402Version,
      paymentPayload,
      paymentRequirements,
    });
  }

  async settle(paymentPayload: PaymentPayload, paymentRequirements: PaymentRequirements): Promise<SettleResponse> {
    return this.request<SettleResponse>('settle', 'POST', '/settle', {
      x402Version: paymentPayload.x402Version,
      paymentPayload,
      paymentRequirements,
    });
  }

  private async request<T>(
    phase: FacilitatorPhase,
    method: 'GET' | 'POST',
    path: string,
    body?: unknown,
  ): Promise<T> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const headers: Record<string, string> = { Accept: 'application/json' };
      if (body !== undefined) headers['Content-Type'] = 'application/json';
      if (this.authMode === 'cdp' && this.createAuthHeaders) {
        Object.assign(headers, await this.createAuthHeaders());
      }

      let response: Response;
      try {
        response = await this.fetchImpl(`${this.url}${path}`, {
          method,
          headers,
          body: body === undefined ? undefined : JSON.stringify(body),
          signal: controller.signal,
        });
      } catch (err) {
        if (err instanceof Error && err.name === 'AbortError') {
          throw new FacilitatorError(`facilitátor (${phase}) neodpověděl do ${this.timeoutMs} ms`, phase, err);
        }
        throw new FacilitatorError(`facilitátor (${phase}) selhal: ${err instanceof Error ? err.message : String(err)}`, phase, err);
      }

      if (!response.ok) {
        const text = await response.text().catch(() => '');
        throw new FacilitatorError(
          `facilitátor (${phase}) vrátil HTTP ${response.status}${text ? `: ${text}` : ''}`,
          phase,
        );
      }

      try {
        return (await response.json()) as T;
      } catch (err) {
        throw new FacilitatorError(`facilitátor (${phase}) vrátil odpověď, kterou nejde přečíst jako JSON`, phase, err);
      }
    } finally {
      clearTimeout(timer);
    }
  }
}
