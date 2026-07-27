/**
 * Verzovaný manifest ověřených dvojic (síť, aktivum).
 *
 * # Proč tenhle soubor existuje
 *
 * Provozní hodnota aktiva přichází z konfigurace (`X402_ASSET`) — v kódu není
 * proto, aby šla měnit bez nasazení. Jenže konfigurace není důkaz: kdo ji umí
 * změnit, umí nasměrovat platby na jiný token.
 *
 * Tenhle manifest je **referenční hodnota, proti které se konfigurace ověřuje**.
 * Není to duplikát konfigurace, je to nezávislý zdroj pravdy, který prochází
 * code review a má historii v gitu.
 *
 * # Proč nestačí on-chain kontrola
 *
 * Dřívější verze tohohle modulu ověřovala aktivum tím, že se kontraktu zeptala
 * na `symbol()` a `decimals()`. **To je špatně a Martin to zachytil:** libovolný
 * ERC-20 může vracet `"USDC"` a `6`. Je to důkaz o chování, ne o identitě.
 *
 * Rozhodující je **přesná dvojice (network, asset)** z tohohle manifestu.
 * On-chain kontroly zůstávají jako defense-in-depth — chytí případ, kdy je
 * manifest správný, ale na dané síti je na té adrese něco jiného, než čekáme.
 *
 * # Jak se sem přidává záznam
 *
 * Nikdy z paměti a nikdy z jednoho zdroje. Minimálně dva nezávislé oficiální
 * zdroje se musí shodnout, a ideálně se to potvrdí čtením z řetězce. Ke každému
 * záznamu patří `verifiedOn` a `sources` — bez nich se nedá poznat, jestli je
 * hodnota ověřená, nebo jen dlouho nezpochybněná.
 */

export interface AssetManifestEntry {
  /** CAIP-2 identifikátor sítě. */
  network: string;
  /** Adresa kontraktu, lowercase pro porovnání. */
  asset: string;
  symbol: string;
  decimals: number;
  /** Jdou přes tuhle dvojici reálné peníze? */
  mainnet: boolean;
  /** Datum, kdy byla hodnota naposledy ověřena proti zdrojům níž. */
  verifiedOn: string;
  sources: string[];
  note?: string;
  /**
   * EIP-712 doména tokenu. Klient ji potřebuje k podpisu autorizace podle
   * EIP-3009 a bez ní `createPaymentPayload` skončí chybou.
   *
   * ⚠️ **Liší se mezi sítěmi.** Ověřeno čtením z řetězce 27. 7.: na Base Sepolia
   * je `name = "USDC"`, na Base mainnet `name = "USD Coin"`. Kdyby se hodnota
   * zadrátovala podle testnetu, na mainnetu by byl **každý podpis neplatný** —
   * a testnet by to neodhalil nikdy.
   */
  eip712: { name: string; version: string };
}

/**
 * Ověřeno 2026-07-27 ze dvou nezávislých oficiálních zdrojů, které se shodly,
 * a navíc potvrzeno přímým čtením z řetězce (proxy → implementace → přítomnost
 * selektorů `transferWithAuthorization`, `receiveWithAuthorization`,
 * `authorizationState`; `decimals()` = 6, `symbol()` = "USDC").
 */
export const ASSET_MANIFEST: readonly AssetManifestEntry[] = [
  {
    network: 'eip155:8453',
    asset: '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913',
    symbol: 'USDC',
    decimals: 6,
    mainnet: true,
    verifiedOn: '2026-07-27',
    sources: [
      'https://developers.circle.com/stablecoins/usdc-contract-addresses',
      'https://docs.cdp.coinbase.com/x402/network-support',
      'on-chain: mainnet.base.org, proxy 0x8335… → impl 0x2ce6311ddae708829bc0784c967b7d77d19fd779, name()/version()',
    ],
    eip712: { name: 'USD Coin', version: '2' },
    note: 'nativní Circle USDC na Base — NE bridged USDbC. Doména se jmenuje "USD Coin", ne "USDC"',
  },
  {
    network: 'eip155:84532',
    asset: '0x036cbd53842c5426634e7929541ec2318f3dcf7e',
    symbol: 'USDC',
    decimals: 6,
    mainnet: false,
    verifiedOn: '2026-07-27',
    sources: [
      'https://developers.circle.com/stablecoins/usdc-contract-addresses',
      'https://docs.cdp.coinbase.com/x402/network-support',
      'on-chain: sepolia.base.org, decimals()=6, name()/version()',
    ],
    eip712: { name: 'USDC', version: '2' },
    note: 'testnet USDC na Base Sepolia',
  },
];

/**
 * Adresy, o kterých víme, že jsou špatné. Zůstává jako **dodatečná pojistka**,
 * ne jako náhrada allowlistu — allowlist odmítne všechno neznámé, denylist
 * odmítne jen to, co jsme stihli pojmenovat.
 */
export const FORBIDDEN_ASSETS: ReadonlyMap<string, string> = new Map([
  [
    '0xd9aaec86b65d86f6a7b5b1b0c42ffa531710b6ca',
    'bridged USDbC na Base — Circle k němu říká „carries no guarantee from Circle" ' +
      'a doporučuje migraci na nativní USDC',
  ],
]);

/** Najde záznam pro dvojici (síť, aktivum). `null` = dvojice není ověřená. */
export function findManifestEntry(network: string, asset: string): AssetManifestEntry | null {
  const needle = asset.trim().toLowerCase();
  return ASSET_MANIFEST.find((e) => e.network === network && e.asset === needle) ?? null;
}
