/**
 * Brána: spojuje konfiguraci, sedm kontrol a facilitátora do jedné cesty.
 *
 * Tenhle soubor rozhoduje o **pořadí operací**, a to je jediné, na čem u placené
 * brány doopravdy záleží. Samotné kontroly můžou být správné a stejně se dají
 * zapojit tak, že se data vydají dřív, než jsou zaplacená.
 */
import {
  runAllChecks, createMemoryReplayStore, type Authorization, type CheckResult,
  type ReplayStore, type AmountFacts,
} from './checks.js';
import type { X402Config } from './config.js';
import { findManifestEntry } from './asset-manifest.js';
import type {
  Facilitator, Network, PaymentPayload, PaymentRequirements, ResourceInfo, SettleResponse,
} from './facilitator.js';
import {
  x402OffersTotal, x402SettlementsTotal, x402FacilitatorErrorsTotal, x402CheckRejectionsTotal,
} from './metrics.js';

/** Kolik atomických jednotek je jeden USD u aktiva se šesti desetinnými místy. */
const USDC_DECIMALS = 6;

/**
 * Cena v USD → atomické jednotky. Přes celá čísla, ne přes float:
 * `0.005 * 1e6` v plovoucí čárce umí vrátit 4999.999999999999.
 */
export function priceToAtomic(priceUsd: number, decimals = USDC_DECIMALS): string {
  if (!Number.isFinite(priceUsd) || priceUsd < 0) throw new Error(`neplatná cena: ${priceUsd}`);
  const parts = priceUsd.toFixed(decimals).split('.');
  const whole = parts[0] ?? '0';
  const frac = parts[1] ?? '';
  return (BigInt(whole) * 10n ** BigInt(decimals) + BigInt(frac.padEnd(decimals, '0') || '0')).toString();
}

export interface OfferedPayment {
  requirements: PaymentRequirements;
  /**
   * Zdroj, ke kterému nabídka patří — ve tvaru, který čeká protokol.
   *
   * ⚠️ Není to řetězec. Ověřeno ve skutečném SDK (`@x402/core@2.19.0`):
   * `PaymentRequired.resource` je **povinný `ResourceInfo`** a klient ho
   * v payloadu vrací beze změny zpátky (`resource: paymentRequired.resource`).
   * Kdybychom posílali řetězec, přísný klient by nabídku odmítl a naše kontrola
   * resource bindingu by nikdy neseděla — a poznali bychom to až u první ostré
   * platby.
   *
   * Identifikátor rozsahu práce se proto nese v `url`.
   */
  resource: ResourceInfo;
}

export type RedeemOutcome =
  /**
   * `settlement: null` znamená, že se data vydávají PŘED usazením platby
   * (`X402_SETTLE_BEFORE_RELEASE=false`, konvence x402 nad HTTP). Volající pak
   * musí settlement dokončit sám a nese riziko, že selže.
   *
   * Záměrně je to `null`, ne vymyšlená odpověď s `success: true` a prázdným
   * hashem — ta by v telemetrii vypadala jako úspěšná platba, která se nikdy
   * nestala.
   */
  | { released: true; settlement: SettleResponse | null; amounts?: AmountFacts }
  | { released: false; reason: string; code: string; amounts?: AmountFacts };

export interface X402Gate {
  offer(resource: string): OfferedPayment;
  /** Kanonická podoba identifikátoru zdroje, jak putuje po drátě. */
  resourceUrl(resource: string): string;
  redeem(input: {
    payload: unknown;
    expectedResource: string;
    now?: number;
  }): Promise<RedeemOutcome>;
}

/** Minimální tvar payloadu, na který se brána dívá. Zbytek si ověří facilitátor. */
interface IncomingPayload {
  x402Version?: number;
  resource?: { url?: unknown };
  accepted?: { network?: string; asset?: string };
  payload?: { authorization?: Authorization };
}

export function createX402Gate(
  config: X402Config,
  facilitator: Facilitator,
  options: { replayStore?: ReplayStore; onEvent?: (event: GateEvent) => void } = {},
): X402Gate {
  const replayStore = options.replayStore ?? createMemoryReplayStore();
  const emit = options.onEvent ?? (() => {});
  const amount = priceToAtomic(config.priceUsd);

  return {
    offer(resource) {
      const requirements = offerRequirements(config, amount);
      emit({ kind: 'offer_created', resource });
      return {
        requirements,
        resource: {
          url: resourceUrlFor(config, resource),
          description: 'cz-agents paid resource',
          mimeType: 'application/json',
        },
      };
    },

    resourceUrl(resource) {
      return resourceUrlFor(config, resource);
    },

    async redeem({ payload, expectedResource, now }) {
      emit({ kind: 'payload_received', resource: expectedResource });

      const parsed = payload as IncomingPayload | null;
      const auth = parsed?.payload?.authorization;
      if (!auth || typeof auth !== 'object') {
        return deny('malformed_payload', 'payload neobsahuje autorizaci');
      }

      // 1. NAŠE kontroly první. Facilitátor neví, co servírujeme, a volat ho
      //    s payloadem, o kterém už víme, že patří jinam, je zbytečné.
      const checked: CheckResult = runAllChecks({
        auth,
        payloadNetwork: parsed?.accepted?.network ?? '',
        payloadAsset: parsed?.accepted?.asset ?? '',
        // Klient vrací celý `ResourceInfo`; váže se na jeho `url`, protože to
        // je to jediné, co identifikuje kupovaný zdroj.
        payloadResource: parsed?.resource?.url,
        expectedResource: resourceUrlFor(config, expectedResource),
        expectedAmount: amount,
        config: {
          network: config.network,
          asset: config.asset,
          payTo: config.payTo,
          maxTimeoutSeconds: config.maxTimeoutSeconds,
          settleMarginSeconds: config.settleMarginSeconds,
        },
        replayStore,
        now,
      });
      if (!checked.ok) {
        emit({ kind: 'check_rejected', resource: expectedResource, check: checked.code ?? 'unknown' });
        return { released: false, reason: checked.detail ?? 'kontrola neprošla', code: checked.code ?? 'check_failed', amounts: checked.amounts };
      }

      // 2. Teprve teď facilitátor. Jakákoli jeho chyba znamená NEVYDAT —
      //    nejasný stav settlementu se čte jako nezaplaceno, ne jako zaplaceno.
      try {
        emit({ kind: 'verify_started', resource: expectedResource });
        const verified = await facilitator.verify(payload as PaymentPayload, offerRequirements(config, amount));
        if (!verified.isValid) {
          replayStore.release(auth.nonce);
          emit({ kind: 'verify_failed', resource: expectedResource, detail: verified.invalidReason });
          return deny('verify_failed', verified.invalidReason ?? 'facilitátor platbu neuznal', checked.amounts);
        }
      } catch (error) {
        // Nonce se uvolní: legitimní retry po výpadku facilitátora nemá být
        // trestaný. Škodlivý replay se stejně zastaví na kontraktu.
        replayStore.release(auth.nonce);
        emit({
          kind: 'facilitator_error', resource: expectedResource, phase: 'verify',
          detail: error instanceof Error ? error.message : String(error),
        });
        return deny('facilitator_unavailable', 'ověření platby se nepodařilo dokončit', checked.amounts);
      }

      // 3. Settlement PŘED vydáním dat.
      //
      //    Konvence x402 nad HTTP je verify → handler → settle, tedy data ven
      //    a platba dodatečně. U datového produktu je ale „odesláno a platba
      //    selhala" nevratné — data se nedají vzít zpátky. Martin tuhle
      //    odchylku schválil 27. 7. jako vědomé rozhodnutí; cenou je latence.
      //
      //    Když se `settleBeforeRelease` vypne, chová se to podle konvence
      //    a volající si nese riziko sám.
      if (!config.settleBeforeRelease) {
        emit({ kind: 'released_before_settlement', resource: expectedResource });
        return { released: true, settlement: null, amounts: checked.amounts };
      }

      try {
        emit({ kind: 'settle_started', resource: expectedResource });
        const settlement = await facilitator.settle(payload as PaymentPayload, offerRequirements(config, amount));
        if (!settlement.success) {
          replayStore.release(auth.nonce);
          emit({ kind: 'settle_failed', resource: expectedResource, detail: settlement.errorReason });
          return deny('settle_failed', settlement.errorReason ?? 'platba se neusadila', checked.amounts);
        }
        emit({ kind: 'settled', resource: expectedResource, transaction: settlement.transaction });
        return { released: true, settlement, amounts: checked.amounts };
      } catch (error) {
        replayStore.release(auth.nonce);
        emit({
          kind: 'facilitator_error', resource: expectedResource, phase: 'settle',
          detail: error instanceof Error ? error.message : String(error),
        });
        // Nejednoznačný výsledek: platba mohla projít i neprojít. Data se
        // NEVYDAJÍ — z dvou špatných možností je nevydat to menší zlo, protože
        // nevydaná data jdou vydat později, vydaná se nedají vzít zpátky.
        return deny('settlement_unknown', 'stav platby je nejasný, data se nevydávají', checked.amounts);
      }
    },
  };
}

/**
 * Identifikátor zdroje jako URL. Je to skutečná adresa placeného zdroje, takže
 * je zároveň čitelná pro člověka i použitelná jako binding — nemusí se vymýšlet
 * druhý identifikátor vedle ní.
 */
function resourceUrlFor(config: X402Config, resource: string): string {
  return `${config.resourceBaseUrl}/${encodeURIComponent(resource)}`;
}

function offerRequirements(config: X402Config, amount: string): PaymentRequirements {
  return {
    scheme: 'exact',
    // Konfigurace síť validuje proti CAIP-2 už při načtení, takže tenhle cast
    // jen dorovnává šablonový typ — neobchází kontrolu, ta proběhla dřív.
    network: config.network as Network,
    amount,
    asset: config.asset,
    payTo: config.payTo,
    maxTimeoutSeconds: config.maxTimeoutSeconds,
    // EIP-712 doména tokenu. Bez ní klient autorizaci nepodepíše — a protože se
    // mezi sítěmi liší, bere se z ověřeného manifestu, ne z konstanty.
    extra: eip712Extra(config),
  };
}

function eip712Extra(config: X402Config): Record<string, unknown> {
  const entry = findManifestEntry(config.network, config.asset);
  if (!entry) {
    // Nemělo by nastat: konfigurace prošla allowlistem při načtení. Kdyby přece,
    // je lepší padnout než poslat nabídku, kterou nejde podepsat.
    throw new Error(`x402: aktivum ${config.asset} na ${config.network} není v manifestu`);
  }
  return { name: entry.eip712.name, version: entry.eip712.version };
}

const deny = (code: string, reason: string, amounts?: AmountFacts): RedeemOutcome =>
  ({ released: false, code, reason, amounts });

export type GateEvent =
  | { kind: 'offer_created'; resource: string }
  | { kind: 'payload_received'; resource: string }
  | { kind: 'check_rejected'; resource: string; check: string }
  | { kind: 'verify_started'; resource: string }
  | { kind: 'verify_failed'; resource: string; detail?: string }
  | { kind: 'settle_started'; resource: string }
  | { kind: 'settled'; resource: string; transaction: string }
  | { kind: 'settle_failed'; resource: string; detail?: string }
  | { kind: 'released_before_settlement'; resource: string }
  | { kind: 'facilitator_error'; resource: string; phase: 'verify' | 'settle'; detail?: string };

export interface X402MetricsListenerOptions {
  /** Jméno služby pro label `service` (`sanctions`, `payqr`, ...). */
  service: string;
  /**
   * Jméno placeného nástroje pro label `tool`. Pevný řetězec zvolený volajícím
   * PŘI KONSTRUKCI brány — NIKDY `event.resource`: ten nese proměnné části
   * (počet položek, timestamp) a jako label by rozbil kardinalitu čítače.
   */
  tool: string;
}

/**
 * Napojí čtyři čítače z `metrics.ts` na proud událostí brány a odloguje detail
 * u selhání facilitátora. Bez tohohle by `getX402Metrics()` navěky vracel jen
 * prázdné HELP/TYPE hlavičky — brána se dnes konstruuje bez `onEvent` a
 * opakované selhání settlementu by nikde nebylo vidět.
 *
 * Volá se jednou při konstrukci gate v `http.ts` každé služby
 * (`options.onEvent` u `createX402Gate`).
 */
export function createX402MetricsListener({ service, tool }: X402MetricsListenerOptions): (event: GateEvent) => void {
  return (event) => {
    switch (event.kind) {
      case 'offer_created':
        x402OffersTotal.inc({ service, tool });
        break;
      case 'check_rejected':
        x402CheckRejectionsTotal.inc({ service, check: event.check });
        break;
      case 'verify_failed':
        x402SettlementsTotal.inc({ service, tool, result: 'verify_failed' });
        break;
      case 'settled':
        x402SettlementsTotal.inc({ service, tool, result: 'success' });
        break;
      case 'settle_failed':
        x402SettlementsTotal.inc({ service, tool, result: 'settle_failed' });
        // Kód facilitátoru (např. `invalid_exact_evm_transaction_failed`) se
        // nesmí ztratit — 27. 7. jedna ostrá platba na Base Sepolia takhle
        // selhala a příčina se dodatečně nedala zjistit.
        console.error(`[x402] ${service}/${tool} settlement selhal: ${event.detail ?? 'bez detailu'}`);
        break;
      case 'released_before_settlement':
        x402SettlementsTotal.inc({ service, tool, result: 'released_before_settlement' });
        break;
      case 'facilitator_error': {
        x402FacilitatorErrorsTotal.inc({ service, phase: event.phase });
        x402SettlementsTotal.inc({
          service, tool,
          result: event.phase === 'settle' ? 'settlement_unknown' : 'facilitator_unavailable',
        });
        console.error(`[x402] ${service}/${tool} facilitátor (${event.phase}) selhal: ${event.detail ?? 'bez detailu'}`);
        break;
      }
      // payload_received/verify_started/settle_started: mezikroky bez vlastního
      // čítače — nesou se jen jako signál pro budoucí trasování, ne pro metriku.
      default:
        break;
    }
  };
}
