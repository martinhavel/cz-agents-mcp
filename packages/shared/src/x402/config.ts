/**
 * Konfigurace x402 — fail-closed, bez tichého pádu na testnet.
 *
 * Dvě zásady, ze kterých plyne všechno ostatní:
 *
 * 1. **Vypnuto je vypnuto, zapnuto je úplné.** `loadX402Config` vrátí `null`
 *    (modul vůbec nevznikne), nebo platnou konfiguraci. Nikdy neexistuje stav
 *    „flag zapnutý, ale platby tiše mimo provoz" — to je vzorec, kdy všechno
 *    vypadá, že běží, a přitom se nic neděje.
 *
 * 2. **Chybějící produkční konfigurace není důvod spadnout na testnet.**
 *    Degradace na Sepolii by znamenala, že produkce vydává data proti bezcenným
 *    tokenům — a nikdo by si toho nevšiml, protože by to „fungovalo". Proto se
 *    v takovém případě nestartuje.
 */

import { FORBIDDEN_ASSETS, findManifestEntry } from './asset-manifest.js';

/** CAIP-2 identifikátory. Řetězec `base-sepolia` NENÍ alias — je to chyba. */
export const BASE_MAINNET = 'eip155:8453';
export const BASE_SEPOLIA = 'eip155:84532';

/**
 * Sítě, na kterých jdou reálné peníze. Seznam je zde proto, aby se dalo poznat
 * „tohle je mainnet" bez znalosti konkrétní sítě — ne jako povolený výčet.
 */
const MAINNET_NETWORKS = new Set<string>([BASE_MAINNET]);

/** Facilitátoři, kteří umí jen testnet. Na mainnetu by tiše selhali. */
const TESTNET_ONLY_FACILITATORS = ['x402.org'];

export type FacilitatorAuth = 'none' | 'cdp';

export interface X402Config {
  network: string;
  asset: string;
  payTo: string;
  facilitatorUrl: string;
  facilitatorAuth: FacilitatorAuth;
  priceUsd: number;
  maxTimeoutSeconds: number;
  /**
   * Kolik času musí v autorizaci zbývat, aby mělo smysl začínat settlement.
   * Menší než `maxTimeoutSeconds` — klient nastavuje okno právě na tu hodnotu,
   * takže požadovat ji celou by nešlo splnit.
   */
  settleMarginSeconds: number;
  settleBeforeRelease: boolean;
  isMainnet: boolean;
  /**
   * Základ URL placených zdrojů. Protokol chce `ResourceInfo.url`, takže
   * identifikátor zdroje musí být adresa — ne vymyšlený řetězec vedle ní.
   */
  resourceBaseUrl: string;
}

class X402ConfigError extends Error {
  constructor(variable: string, reason: string) {
    super(`x402 konfigurace: ${variable} — ${reason}`);
    this.name = 'X402ConfigError';
  }
}

const required = (env: NodeJS.ProcessEnv, name: string): string => {
  const value = env[name]?.trim();
  if (!value) throw new X402ConfigError(name, 'chybí nebo je prázdná');
  return value;
};

const HEX_ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const CAIP2 = /^[a-z0-9-]{3,8}:[a-zA-Z0-9-]{1,32}$/;

/**
 * @returns `null` když je x402 vypnuté — volající pak modul nekonstruuje a
 *   `@x402/*` se vůbec nenaimportuje.
 * @throws {X402ConfigError} když je zapnuté a cokoli nesedí. Boot padá se
 *   jménem proměnné, ne s obecným „invalid config".
 */
export function loadX402Config(env: NodeJS.ProcessEnv = process.env): X402Config | null {
  if (env.X402_ENABLED?.trim() !== 'true') return null;

  const network = required(env, 'X402_NETWORK');
  if (!CAIP2.test(network)) {
    throw new X402ConfigError('X402_NETWORK',
      `'${network}' není CAIP-2. Base Sepolia je '${BASE_SEPOLIA}', ne 'base-sepolia'`);
  }

  const asset = required(env, 'X402_ASSET');
  if (!HEX_ADDRESS.test(asset)) {
    throw new X402ConfigError('X402_ASSET', `'${asset}' není adresa kontraktu`);
  }

  // Denylist první, aby známý omyl dostal srozumitelnou hlášku místo obecného
  // „není v manifestu". Je to ale jen pojistka, ne rozhodující kontrola.
  const forbidden = FORBIDDEN_ASSETS.get(asset.toLowerCase());
  if (forbidden) throw new X402ConfigError('X402_ASSET', forbidden);

  // Rozhodující je ALLOWLIST: přesná dvojice (síť, aktivum) musí být ve
  // verzovaném manifestu. Konfigurace říká, co použít; manifest říká, co je
  // vůbec přípustné. Neznámá dvojice = nestartujeme, i kdyby ta adresa byla
  // sebevíc podobná té správné.
  const manifestEntry = findManifestEntry(network, asset);
  if (!manifestEntry) {
    throw new X402ConfigError('X402_ASSET',
      `dvojice (${network}, ${asset}) není v ověřeném manifestu. ` +
      'Nová dvojice se přidává do asset-manifest.ts po ověření ze dvou nezávislých ' +
      'oficiálních zdrojů, ne změnou konfigurace');
  }
  if (manifestEntry.mainnet !== MAINNET_NETWORKS.has(network)) {
    throw new X402ConfigError('X402_ASSET',
      'manifest a konfigurace se neshodnou v tom, jestli jde o mainnet');
  }

  const payTo = required(env, 'X402_PAY_TO');
  if (!HEX_ADDRESS.test(payTo)) {
    throw new X402ConfigError('X402_PAY_TO', `'${payTo}' není adresa`);
  }

  const facilitatorUrl = required(env, 'X402_FACILITATOR_URL');
  let facilitatorHost: string;
  try {
    facilitatorHost = new URL(facilitatorUrl).host;
  } catch {
    throw new X402ConfigError('X402_FACILITATOR_URL', `'${facilitatorUrl}' není platná URL`);
  }

  const authRaw = env.X402_FACILITATOR_AUTH?.trim() ?? 'none';
  if (authRaw !== 'none' && authRaw !== 'cdp') {
    throw new X402ConfigError('X402_FACILITATOR_AUTH', `'${authRaw}' není 'none' ani 'cdp'`);
  }
  const facilitatorAuth: FacilitatorAuth = authRaw;

  const priceUsd = Number(required(env, 'X402_PRICE_USD'));
  if (!Number.isFinite(priceUsd) || priceUsd <= 0) {
    throw new X402ConfigError('X402_PRICE_USD', 'musí být kladné číslo');
  }

  const maxTimeoutSeconds = Number(env.X402_MAX_TIMEOUT_SECONDS?.trim() ?? '60');
  if (!Number.isInteger(maxTimeoutSeconds) || maxTimeoutSeconds <= 0) {
    throw new X402ConfigError('X402_MAX_TIMEOUT_SECONDS', 'musí být kladné celé číslo');
  }

  const settleMarginSeconds = Number(env.X402_SETTLE_MARGIN_SECONDS?.trim() ?? '10');
  if (!Number.isInteger(settleMarginSeconds) || settleMarginSeconds <= 0) {
    throw new X402ConfigError('X402_SETTLE_MARGIN_SECONDS', 'musí být kladné celé číslo');
  }
  if (settleMarginSeconds >= maxTimeoutSeconds) {
    throw new X402ConfigError('X402_SETTLE_MARGIN_SECONDS',
      `musí být menší než X402_MAX_TIMEOUT_SECONDS (${maxTimeoutSeconds}); klient nastavuje okno právě na tu hodnotu`);
  }

  // Výchozí true: settlement před vydáním dat. Odchylka od HTTP konvence, ale
  // u datového produktu je „odesláno a platba selhala" nevratné.
  const settleBeforeRelease = (env.X402_SETTLE_BEFORE_RELEASE?.trim() ?? 'true') !== 'false';

  const isMainnet = MAINNET_NETWORKS.has(network);

  if (isMainnet) {
    // Druhý, vědomý přepínač. Jedna env hodnota nesmí stačit k tomu, aby začaly
    // téct reálné peníze.
    if (env.X402_ALLOW_MAINNET?.trim() !== 'true') {
      throw new X402ConfigError('X402_ALLOW_MAINNET',
        `síť '${network}' jsou reálné peníze; vyžaduje výslovné X402_ALLOW_MAINNET=true`);
    }
    // Pozitivní kontrola: testnet-only facilitátor by na mainnetu selhal až za
    // běhu, u prvního zákazníka. Lepší nenastartovat.
    if (TESTNET_ONLY_FACILITATORS.some((h) => facilitatorHost.endsWith(h))) {
      throw new X402ConfigError('X402_FACILITATOR_URL',
        `'${facilitatorHost}' umí jen testnet, na '${network}' ho použít nelze`);
    }
    if (facilitatorAuth !== 'cdp') {
      throw new X402ConfigError('X402_FACILITATOR_AUTH',
        'mainnet vyžaduje autentizovaný facilitátor (cdp)');
    }
  }

  const resourceBaseUrl = (env.X402_RESOURCE_BASE_URL?.trim() ?? 'https://cz-agents.dev/x402').replace(/\/+$/, '');
  try { new URL(resourceBaseUrl); } catch {
    throw new X402ConfigError('X402_RESOURCE_BASE_URL', `'${resourceBaseUrl}' není platná URL`);
  }

  return {
    network, asset, payTo, facilitatorUrl, facilitatorAuth,
    priceUsd, maxTimeoutSeconds, settleMarginSeconds, settleBeforeRelease, isMainnet, resourceBaseUrl,
  };
}

/**
 * Pozitivní ověření aktiva **proti řetězci, ne proti konstantě v kódu**.
 *
 * Zadání zakazuje hardcodovat produkční adresu USDC a zároveň žádá ověřit, že
 * produkce uvádí správný kontrakt. To se vylučuje jen zdánlivě: adresa přijde
 * z konfigurace a ověří se tím, že se jí zeptáme, čím je. Kontrakt, který se
 * hlásí jako `USDC` se šesti desetinnými místy, je silnější důkaz než shoda
 * s řetězcem, který jsme si někam opsali.
 *
 * Volá se **při startu služby**, ne ve fázi 1 (ta je bez sítě). Selhání = boot
 * padá; na mainnetu nechceme běžet proti kontraktu, o kterém nic nevíme.
 *
 * @param rpcCall Nízkoúrovňové `eth_call` — vstřikuje se, aby šlo testovat bez sítě.
 */
export async function assertAssetOnChain(
  config: X402Config,
  rpcCall: (to: string, data: string) => Promise<string>,
): Promise<void> {
  const DECIMALS = '0x313ce567'; // decimals()
  const SYMBOL = '0x95d89b41';   // symbol()

  const decimalsRaw = await rpcCall(config.asset, DECIMALS);
  const decimals = Number(BigInt(decimalsRaw));
  if (decimals !== 6) {
    throw new X402ConfigError('X402_ASSET',
      `kontrakt hlásí ${decimals} desetinných míst, USDC má 6 — je to jiný token`);
  }

  const symbolRaw = await rpcCall(config.asset, SYMBOL);
  const symbol = decodeAbiString(symbolRaw);
  if (symbol !== 'USDC') {
    throw new X402ConfigError('X402_ASSET', `kontrakt se hlásí jako '${symbol}', ne 'USDC'`);
  }
}

/** ABI-zakódovaný `string` z `eth_call`: offset, délka, data. */
function decodeAbiString(hex: string): string {
  const body = hex.startsWith('0x') ? hex.slice(2) : hex;
  if (body.length < 128) return '';
  const length = Number(BigInt('0x' + body.slice(64, 128)));
  const bytes = body.slice(128, 128 + length * 2);
  return Buffer.from(bytes, 'hex').toString('utf8').replace(/\0+$/, '');
}
