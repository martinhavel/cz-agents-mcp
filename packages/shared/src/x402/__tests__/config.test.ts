import { describe, expect, it } from 'vitest';
import { loadX402Config, assertAssetOnChain, BASE_MAINNET, BASE_SEPOLIA } from '../config.js';
import { findManifestEntry } from '../asset-manifest.js';

const USDC_SEPOLIA = '0x036CbD53842c5426634e7929541eC2318f3dCF7e';
const USDC_MAINNET = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
const USDBC_BRIDGED = '0xd9aAEc86B65D86f6A7B5B1b0c42FFA531710b6CA';
const PAY_TO = '0x1111111111111111111111111111111111111111';

const testnetEnv = (over: Record<string, string | undefined> = {}): NodeJS.ProcessEnv => ({
  X402_ENABLED: 'true',
  X402_NETWORK: BASE_SEPOLIA,
  X402_ASSET: USDC_SEPOLIA,
  X402_PAY_TO: PAY_TO,
  X402_FACILITATOR_URL: 'https://x402.org/facilitator',
  X402_PRICE_USD: '0.005',
  ...over,
});

const mainnetEnv = (over: Record<string, string | undefined> = {}): NodeJS.ProcessEnv =>
  testnetEnv({
    X402_NETWORK: BASE_MAINNET,
    X402_ASSET: USDC_MAINNET,
    X402_FACILITATOR_URL: 'https://api.cdp.coinbase.com/platform/v2/x402',
    X402_FACILITATOR_AUTH: 'cdp',
    X402_ALLOW_MAINNET: 'true',
    ...over,
  });

describe('x402 config — vypnuto znamená vypnuto', () => {
  it('bez X402_ENABLED vrací null, ne prázdnou konfiguraci', () => {
    expect(loadX402Config({})).toBeNull();
    expect(loadX402Config({ X402_ENABLED: 'false' })).toBeNull();
    // Pravdivé jen doslova 'true' — 'TRUE', '1' ani 'yes' platby nezapnou.
    expect(loadX402Config({ X402_ENABLED: '1' })).toBeNull();
  });

  it('vypnuté nevyžaduje žádnou další proměnnou', () => {
    expect(() => loadX402Config({ X402_ENABLED: 'false', X402_NETWORK: 'nesmysl' })).not.toThrow();
  });
});

describe('x402 config — zapnuté a neúplné padá se jménem proměnné', () => {
  for (const missing of ['X402_NETWORK', 'X402_ASSET', 'X402_PAY_TO', 'X402_FACILITATOR_URL', 'X402_PRICE_USD']) {
    it(`chybějící ${missing} shodí boot a zpráva ho jmenuje`, () => {
      expect(() => loadX402Config(testnetEnv({ [missing]: undefined }))).toThrow(missing);
    });
  }

  it('nikdy nedegraduje na testnet — neúplná konfigurace nespustí nic', () => {
    // Kdyby fallback existoval, tenhle případ by vrátil testnetovou konfiguraci
    // místo výjimky, a produkce by tiše přijímala bezcenné tokeny.
    expect(() => loadX402Config(mainnetEnv({ X402_PAY_TO: undefined }))).toThrow('X402_PAY_TO');
  });

  it('odmítá legacy název sítě a řekne, jak má vypadat', () => {
    expect(() => loadX402Config(testnetEnv({ X402_NETWORK: 'base-sepolia' })))
      .toThrow(/CAIP-2/);
  });

  it('odmítá nekladnou cenu a nesmyslný timeout', () => {
    expect(() => loadX402Config(testnetEnv({ X402_PRICE_USD: '0' }))).toThrow('X402_PRICE_USD');
    expect(() => loadX402Config(testnetEnv({ X402_PRICE_USD: '-1' }))).toThrow('X402_PRICE_USD');
    expect(() => loadX402Config(testnetEnv({ X402_MAX_TIMEOUT_SECONDS: '0' })))
      .toThrow('X402_MAX_TIMEOUT_SECONDS');
  });
});

describe('x402 config — aktivum rozhoduje allowlist, ne chování kontraktu', () => {
  it('přijme ověřenou dvojici (síť, aktivum)', () => {
    const config = loadX402Config(testnetEnv());
    expect(config?.asset).toBe(USDC_SEPOLIA);
    expect(config?.isMainnet).toBe(false);
  });

  it('velikost písmen v adrese nerozhoduje', () => {
    expect(loadX402Config(testnetEnv({ X402_ASSET: USDC_SEPOLIA.toLowerCase() }))).not.toBeNull();
  });

  it('odmítne správnou adresu na ŠPATNÉ síti', () => {
    // Mainnetové USDC na testnetu je neověřená dvojice, i když obě hodnoty
    // samostatně v manifestu jsou. Rozhoduje dvojice, ne adresa.
    expect(() => loadX402Config(testnetEnv({ X402_ASSET: USDC_MAINNET })))
      .toThrow(/manifestu/);
  });

  it('odmítne neznámou adresu, i když vypadá věrohodně', () => {
    expect(() => loadX402Config(testnetEnv({ X402_ASSET: '0x1111111111111111111111111111111111111111' })))
      .toThrow(/manifestu/);
  });

  it('odmítne bridged USDbC s vlastním vysvětlením, ne obecnou hláškou', () => {
    expect(() => loadX402Config(mainnetEnv({ X402_ASSET: USDBC_BRIDGED })))
      .toThrow(/USDbC/);
  });

  it('manifest zná obě sítě a označuje mainnet správně', () => {
    expect(findManifestEntry(BASE_MAINNET, USDC_MAINNET)?.mainnet).toBe(true);
    expect(findManifestEntry(BASE_SEPOLIA, USDC_SEPOLIA)?.mainnet).toBe(false);
    expect(findManifestEntry(BASE_MAINNET, USDC_SEPOLIA)).toBeNull();
  });
});

describe('x402 config — reálné peníze vyžadují druhý vědomý přepínač', () => {
  it('mainnet bez X402_ALLOW_MAINNET nenastartuje', () => {
    expect(() => loadX402Config(mainnetEnv({ X402_ALLOW_MAINNET: undefined })))
      .toThrow('X402_ALLOW_MAINNET');
  });

  it('mainnet s testnetovým facilitátorem nenastartuje', () => {
    expect(() => loadX402Config(mainnetEnv({ X402_FACILITATOR_URL: 'https://x402.org/facilitator' })))
      .toThrow(/jen testnet/);
  });

  it('mainnet bez autentizovaného facilitátoru nenastartuje', () => {
    expect(() => loadX402Config(mainnetEnv({ X402_FACILITATOR_AUTH: 'none' })))
      .toThrow('X402_FACILITATOR_AUTH');
  });

  it('kompletní mainnetová konfigurace projde a je označená jako mainnet', () => {
    const config = loadX402Config(mainnetEnv());
    expect(config?.isMainnet).toBe(true);
    expect(config?.network).toBe(BASE_MAINNET);
  });

  it('testnet naopak druhý přepínač nevyžaduje', () => {
    expect(loadX402Config(testnetEnv())?.isMainnet).toBe(false);
  });
});

describe('x402 config — on-chain kontrola je defense-in-depth, ne důkaz identity', () => {
  const encodeString = (s: string): string => {
    const hex = Buffer.from(s, 'utf8').toString('hex').padEnd(64, '0');
    return '0x' + (32).toString(16).padStart(64, '0') + s.length.toString(16).padStart(64, '0') + hex;
  };
  const rpc = (decimals: number, symbol: string) => async (_to: string, data: string) =>
    data === '0x313ce567' ? '0x' + decimals.toString(16).padStart(64, '0') : encodeString(symbol);

  it('projde u kontraktu, který se chová jako USDC', async () => {
    const config = loadX402Config(testnetEnv())!;
    await expect(assertAssetOnChain(config, rpc(6, 'USDC'))).resolves.toBeUndefined();
  });

  it('padne na jiném počtu desetinných míst', async () => {
    const config = loadX402Config(testnetEnv())!;
    await expect(assertAssetOnChain(config, rpc(18, 'USDC'))).rejects.toThrow(/desetinných/);
  });

  it('padne na jiném symbolu', async () => {
    const config = loadX402Config(testnetEnv())!;
    await expect(assertAssetOnChain(config, rpc(6, 'FAKE'))).rejects.toThrow(/FAKE/);
  });

  it('POZOR: sám o sobě identitu nedokazuje — podvržený kontrakt projde', async () => {
    // Tenhle test nehlídá kód, hlídá pochopení. Libovolný ERC-20 může vracet
    // "USDC" a 6 desetinných míst; kdyby tahle kontrola byla jediná, stačilo by
    // nasměrovat X402_ASSET na podvrh. Proto rozhoduje allowlist v manifestu
    // a tohle je až druhá vrstva.
    const config = loadX402Config(testnetEnv())!;
    await expect(assertAssetOnChain(config, rpc(6, 'USDC'))).resolves.toBeUndefined();
  });
});
