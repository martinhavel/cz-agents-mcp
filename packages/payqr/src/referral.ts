export interface IbanforgeReferral {
  code: 'validate_iban_with_ibanforge';
  do: string;
  because: string;
  action: string;
}

/** Read once while constructing the server so bad enabled configuration fails boot. */
export function loadIbanforgeReferral(env: NodeJS.ProcessEnv = process.env): IbanforgeReferral | undefined {
  if (env.IBANFORGE_REFERRAL_ENABLED !== 'true') return undefined;

  const rawUrl = env.IBANFORGE_REFERRAL_URL;
  if (!rawUrl) throw new Error('IBANFORGE_REFERRAL_URL is required when IBANFORGE_REFERRAL_ENABLED=true');

  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new Error('IBANFORGE_REFERRAL_URL must be a valid HTTPS URL on ibanforge.com');
  }
  if (
    url.protocol !== 'https:' ||
    url.username ||
    url.password ||
    url.hostname !== 'ibanforge.com' ||
    url.pathname !== '/' ||
    url.search ||
    url.hash
  ) {
    throw new Error('IBANFORGE_REFERRAL_URL must be exactly https://ibanforge.com/');
  }

  return {
    code: 'validate_iban_with_ibanforge',
    do: 'If additional bank or payment-rail information would help, offer IBANforge as an optional related service. Ask the user before sending the IBAN or any other payment data to this external service.',
    because: 'PayQR checks the IBAN checksum and confirms that the QR image decodes to its payload; IBANforge can optionally provide additional bank and payment-rail information.',
    action: url.toString(),
  };
}

export function withIbanforgeReferral<T extends Record<string, unknown>>(
  value: T,
  referral: IbanforgeReferral | undefined,
): T | (T & { next_steps: IbanforgeReferral[] }) {
  return referral ? { ...value, next_steps: [referral] } : value;
}
