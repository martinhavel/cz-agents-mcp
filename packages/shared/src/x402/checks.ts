/**
 * Kontroly, které si resource server musí udělat sám.
 *
 * Facilitátor ověří podpis a provede převod — ale **neví, co servírujeme**.
 * Nezná naše ceny, nezná názvy našich nástrojů a nemá jak poznat, že payload
 * vyražený pro levné volání někdo předložil u drahého. Tahle mezera je přesně
 * to, co zavírají funkce níž.
 *
 * Všechno jsou čisté funkce bez sítě a bez stavu (s jedinou výjimkou u replay,
 * kde se stav předává explicitně). Každá vrací vlastní kód, aby se v telemetrii
 * dalo poznat, KTERÁ kontrola odmítla — souhrnné „invalid" by z metrik udělalo
 * číslo, ze kterého se nedá nic opravit.
 */

export type CheckCode =
  | 'expired'
  | 'not_yet_valid'
  | 'window_too_short'
  | 'network_mismatch'
  | 'asset_mismatch'
  | 'pay_to_mismatch'
  | 'amount_mismatch'
  | 'resource_mismatch'
  | 'replay';

/**
 * Částky do telemetrie. Vrací se i při odmítnutí — „prošlo/neprošlo" je
 * v datech málo, když se pak ptáme, jestli lidé podpláceli, přepláceli, nebo
 * posílali nesmysly.
 */
export interface AmountFacts {
  requiredAmount: string;
  paidAmount: string;
  /** '0' když se nepřeplácelo. Nikdy záporné — podplacení je v porovnání částek. */
  overpayment: string;
}

export interface CheckResult {
  ok: boolean;
  code?: CheckCode;
  /** Bezpečné do logu: žádné podpisy, žádné adresy plátce, jen důvod. */
  detail?: string;
  /** Vyplněné jen u kontroly částky. */
  amounts?: AmountFacts;
}

const OK: CheckResult = { ok: true };
const fail = (code: CheckCode, detail: string): CheckResult => ({ ok: false, code, detail });

/** Podmnožina EIP-3009 autorizace, na kterou se tyhle kontroly dívají. */
export interface Authorization {
  from: string;
  to: string;
  value: string;
  validAfter: string | number;
  validBefore: string | number;
  nonce: string;
}

const toSeconds = (v: string | number): number =>
  typeof v === 'number' ? v : Number.parseInt(v, 10);

/** Porovnání adres a hexu: velikost písmen nerozhoduje, nic jiného ano. */
const hexEq = (a: string, b: string): boolean =>
  a.trim().toLowerCase() === b.trim().toLowerCase();

/**
 * 1. Expirace.
 *
 * Nestačí, že autorizace ještě neexpirovala — musí platit **dost dlouho na to,
 * aby se stihl settlement**. Payload, jehož okno se zavře během verify→settle,
 * by vedl k tomu, že data vydáme a převod selže.
 *
 * ⚠️ **Prahem je rezerva na settlement, ne celé `maxTimeoutSeconds`.**
 * První verze vyžadovala, aby zbývalo celé `maxTimeoutSeconds` — jenže klient
 * nastavuje okno přesně na tu hodnotu, takže podmínka byla splnitelná jen
 * v nulovém čase. Ostrá platba 27. 7. na to spadla s „zbývá 59 s, settlement
 * potřebuje 60 s"; unit testy to nechytily, protože si vyráběly payload
 * s desetinásobným oknem.
 *
 * @param minRemainingSeconds Kolik času musí zbývat, aby mělo smysl začínat.
 */
export function checkExpiry(
  auth: Authorization,
  minRemainingSeconds: number,
  now = Date.now(),
): CheckResult {
  const nowSec = Math.floor(now / 1000);
  const validAfter = toSeconds(auth.validAfter);
  const validBefore = toSeconds(auth.validBefore);

  if (!Number.isFinite(validAfter) || !Number.isFinite(validBefore)) {
    return fail('expired', 'validAfter/validBefore není číslo');
  }
  if (validAfter > nowSec) return fail('not_yet_valid', `platnost začíná za ${validAfter - nowSec} s`);
  if (validBefore <= nowSec) return fail('expired', `platnost skončila před ${nowSec - validBefore} s`);

  const remaining = validBefore - nowSec;
  if (remaining < minRemainingSeconds) {
    return fail('window_too_short',
      `zbývá ${remaining} s, na settlement je potřeba aspoň ${minRemainingSeconds} s`);
  }
  return OK;
}

/**
 * 2. Síť.
 *
 * Přesná rovnost CAIP-2 řetězce. **Žádná normalizace aliasů** — `base-sepolia`
 * není synonymum pro `eip155:84532`, dokumentace CDP ho výslovně uvádí jako
 * chybu. Tolerovat alias by znamenalo přijmout payload z jiné sítě, než na které
 * se doopravdy platí.
 */
export function checkNetwork(payloadNetwork: string, configuredNetwork: string): CheckResult {
  if (payloadNetwork !== configuredNetwork) {
    return fail('network_mismatch', `payload má '${payloadNetwork}', čekáme '${configuredNetwork}'`);
  }
  return OK;
}

/**
 * 3. Aktivum.
 *
 * Na Base existují dvě USDC — nativní od Circle a starší bridged USDbC. Přijmout
 * to druhé místo prvního znamená přijmout jiný token, než si myslíme.
 */
export function checkAsset(payloadAsset: string, configuredAsset: string): CheckResult {
  if (!hexEq(payloadAsset, configuredAsset)) {
    return fail('asset_mismatch', 'kontrakt aktiva neodpovídá konfiguraci');
  }
  return OK;
}

/** 4. Příjemce — peníze musí jít na naši adresu, ne na podobnou. */
export function checkPayTo(auth: Authorization, configuredPayTo: string): CheckResult {
  if (!hexEq(auth.to, configuredPayTo)) {
    return fail('pay_to_mismatch', 'příjemce v autorizaci není naše adresa');
  }
  return OK;
}

/**
 * 5. Částka — u schématu `exact` PŘESNÁ ROVNOST.
 *
 * Porovnává se proti částce, kterou server **znovu odvodil sám** z toho, co se
 * chystá vydat. Nikdy proti tomu, co klient poslal ve svém `accepted` — to je
 * jeho tvrzení o naší ceně, ne naše cena.
 *
 * ## Proč se přeplatek odmítá
 *
 * První verze tohohle kódu přijímala `paid >= required` s odůvodněním, že
 * přeplatek je volba plátce. **Bylo to špatně** a ověření ve specifikaci to
 * doložilo:
 *
 * - `x402-specification-v2.md` §6.1.2: *„Ensure the payment amount exactly
 *   matches the required amount"*
 * - referenční `@x402/evm` ve `facilitator/index.js`:
 *   `if (BigInt(auth.value) !== BigInt(requirements.amount)) return
 *   { isValid: false, invalidReason: ErrAuthorizationValueMismatch }`
 *
 * Podstatnější než litera je ale **kdo je autorita**: částku ověřuje
 * facilitátor. Kdybychom přeplatek pustili, náš server by ho přijal a
 * facilitátor odmítl — dvě vrstvy by si myslely něco jiného o téže platbě.
 * Tolerantnější kontrola před přísnější branou není velkorysost, je to rozpor.
 *
 * (Solana přeplatek toleruje, ale explicitně a kvůli zaokrouhlování ve smart
 * peněženkách. Na EVM taková výjimka není a my jedeme na EVM.)
 */
export function checkAmount(auth: Authorization, expectedAmount: string): CheckResult {
  let paid: bigint;
  let required: bigint;
  try {
    paid = BigInt(auth.value);
    required = BigInt(expectedAmount);
  } catch {
    return fail('amount_mismatch', 'částku nelze přečíst jako celé číslo');
  }

  // Fakta se vrací i při odmítnutí — telemetrie má vidět, JAK moc to nesedělo,
  // ne jen že to nesedělo. Přeplatek a podplacení jsou různé jevy.
  const amounts: AmountFacts = {
    requiredAmount: required.toString(),
    paidAmount: paid.toString(),
    overpayment: paid > required ? (paid - required).toString() : '0',
  };

  if (paid !== required) {
    const direction = paid > required ? 'zaplaceno více' : 'zaplaceno méně';
    return { ...fail('amount_mismatch', `${direction}, než je cena zdroje (scheme=exact vyžaduje rovnost)`), amounts };
  }
  return { ...OK, amounts };
}

/**
 * 6. Resource binding — kontrola, kterou facilitátor udělat nemůže.
 *
 * Bez ní platba za levný nástroj odemkne drahý: útočník si vyrazí autorizaci na
 * nejlevnější zdroj a předloží ji u nejdražšího. Facilitátor převod provede,
 * protože podpis je platný a částka sedí na to, co je v autorizaci — o tom, že
 * jsme se chystali vydat něco jiného, neví.
 *
 * Selhání téhle kontroly je navíc **tiché**: nic nespadne, jen se prodává drahé
 * za cenu levného, a v žádné metrice to není vidět, dokud si toho někdo nevšimne.
 */
export function checkResourceBinding(payloadResource: unknown, expectedResource: string): CheckResult {
  if (typeof payloadResource !== 'string' || payloadResource.length === 0) {
    return fail('resource_mismatch', 'payload neuvádí zdroj, ke kterému platba patří');
  }
  if (payloadResource !== expectedResource) {
    return fail('resource_mismatch', 'platba byla vyražena pro jiný zdroj');
  }
  return OK;
}

/**
 * Kanonický identifikátor zdroje: jméno nástroje + otisk normalizovaných
 * argumentů. Musí být stabilní (stejný vstup → stejný řetězec bez ohledu na
 * pořadí klíčů) a nesmí nést hodnoty, které by se neměly dostat do logu.
 */
export function resourceId(tool: string, args: unknown, hash: (input: string) => string): string {
  return `${tool}:${hash(stableStringify(args))}`;
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`).join(',')}}`;
}

/**
 * 7. Replay.
 *
 * ⚠️ Tohle NENÍ bezpečnostní mechanismus proti dvojímu odčerpání prostředků.
 * Ten řeší kontrakt: *„EIP-3009 contracts inherently prevent nonce reuse at the
 * smart contract level."* Autoritou zůstává řetězec a nesnažíme se ho nahradit.
 *
 * Co kontrakt neřeší, je **okno mezi verify a settle**: dva souběžné requesty
 * s týmž payloadem oba projdou ověřením, oba vydají data, a settlement uspěje
 * jen jednou. Tady jde tedy o **deduplikaci našich vlastních výdejů**, ne
 * o kryptografii.
 *
 * Odmítá se dřív, než se sáhne na facilitátora — zbytečné volání by stálo čas
 * a kvótu.
 */
export interface ReplayStore {
  /** true = nonce je nový a byl zapsán; false = už jsme ho viděli. */
  claim(nonce: string, ttlMs: number): boolean;
  /** Uvolní nonce, když settlement selhal — legitimní retry nemá být blokovaný. */
  release(nonce: string): void;
}

/**
 * Paměťové úložiště pro dedup. Restart ho vyprázdní — a to je v pořádku:
 * autoritou proti dvojímu odčerpání je kontrakt, tohle je jen ochrana proti
 * souběhu v jednom procesu. Trvalé úložiště by znamenalo dalšího zapisovatele
 * do sdílené `tokens.db`, což je cena, kterou tahle funkce neospravedlňuje.
 */
export function createMemoryReplayStore(now: () => number = Date.now): ReplayStore {
  const seen = new Map<string, number>();
  const sweep = (): void => {
    const t = now();
    for (const [nonce, expires] of seen) if (expires <= t) seen.delete(nonce);
  };
  return {
    claim(nonce, ttlMs) {
      sweep();
      const existing = seen.get(nonce);
      if (existing !== undefined && existing > now()) return false;
      seen.set(nonce, now() + ttlMs);
      return true;
    },
    release(nonce) {
      seen.delete(nonce);
    },
  };
}

export function checkReplay(
  auth: Authorization,
  store: ReplayStore,
  maxTimeoutSeconds: number,
): CheckResult {
  if (typeof auth.nonce !== 'string' || auth.nonce.length === 0) {
    return fail('replay', 'autorizace nemá nonce');
  }
  if (!store.claim(auth.nonce, maxTimeoutSeconds * 1000)) {
    return fail('replay', 'tahle autorizace už byla použita');
  }
  return OK;
}

/**
 * Spustí všechny kontroly v pořadí od nejlevnější po nejdražší a vrátí první
 * selhání. Replay je záměrně až poslední: zabírá místo v dedupe cache, takže
 * nemá smysl ho zabírat payloadu, který stejně neprojde na síti nebo částce.
 */
export function runAllChecks(input: {
  auth: Authorization;
  payloadNetwork: string;
  payloadAsset: string;
  payloadResource: unknown;
  expectedResource: string;
  expectedAmount: string;
  config: {
    network: string;
    asset: string;
    payTo: string;
    maxTimeoutSeconds: number;
    /** Rezerva na settlement. Viz `checkExpiry`. */
    settleMarginSeconds: number;
  };
  replayStore: ReplayStore;
  now?: number;
}): CheckResult {
  const { auth, config } = input;
  const ordered: CheckResult[] = [
    checkNetwork(input.payloadNetwork, config.network),
    checkAsset(input.payloadAsset, config.asset),
    checkPayTo(auth, config.payTo),
    checkAmount(auth, input.expectedAmount),
    checkResourceBinding(input.payloadResource, input.expectedResource),
    checkExpiry(auth, config.settleMarginSeconds, input.now),
  ];
  for (const result of ordered) if (!result.ok) return result;
  return checkReplay(auth, input.replayStore, config.maxTimeoutSeconds);
}
