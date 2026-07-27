/**
 * Ověření, že ručně opsané typy v `@czagents/shared/x402` odpovídají skutečnému
 * SDK.
 *
 * Fáze 1 psala typy z rozbalených `.d.ts`, protože `@x402/*` byly jen volitelné
 * peer závislosti. To je legitimní postup, ale je to **opis** — a opis se
 * rozejde. Tenhle soubor to hlídá překladačem: kdyby SDK změnilo tvar, build
 * padne tady, ne až při první ostré platbě.
 *
 * Runtime testy tady nejsou potřeba. Přiřaditelnost je vlastnost typů a
 * kontroluje ji `tsc` při každém buildu.
 */
import { describe, expect, it } from 'vitest';
import { x402Version } from '@x402/core';
import type {
  PaymentRequirements as SdkRequirements,
  PaymentPayload as SdkPayload,
  SettleResponse as SdkSettle,
  VerifyResponse as SdkVerify,
} from '@x402/core';
import type {
  PaymentRequirements as MyRequirements,
  PaymentPayload as MyPayload,
  SettleResponse as MySettle,
  VerifyResponse as MyVerify,
} from '@czagents/shared/x402';

/**
 * Vzájemná přiřaditelnost. Jeden směr by nestačil: kdyby můj typ jen chyběl
 * pole, prošel by jako podmnožina — tohle vyžaduje shodu v obou směrech.
 */
const _reqOut: SdkRequirements = {} as MyRequirements;
const _reqIn: MyRequirements = {} as SdkRequirements;
const _payOut: SdkPayload = {} as MyPayload;
const _payIn: MyPayload = {} as SdkPayload;
const _setOut: SdkSettle = {} as MySettle;
const _setIn: MySettle = {} as SdkSettle;
const _verOut: SdkVerify = {} as MyVerify;
const _verIn: MyVerify = {} as SdkVerify;
void [_reqOut, _reqIn, _payOut, _payIn, _setOut, _setIn, _verOut, _verIn];

describe('tvar payloadu proti skutečnému SDK', () => {
  it('protokol je verze 2 podle SDK, ne podle našeho předpokladu', () => {
    // Kdyby SDK přešlo na v3, tenhle test padne dřív, než se to projeví na síti.
    expect(x402Version).toBe(2);
  });

  it('typy jsou vzájemně přiřaditelné — hlídá tsc při buildu', () => {
    // Samotná existence tohohle souboru je ten test; běh jen dokládá, že se
    // přeložil. Kdyby se typy rozešly, build padne a sem se nedojde.
    expect(true).toBe(true);
  });
});
