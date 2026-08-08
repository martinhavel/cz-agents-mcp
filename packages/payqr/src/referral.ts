export type IbanforgeRelationship = 'unpaid_partner' | 'affiliate';

export interface IbanforgeReferral {
  code: 'validate_iban_with_ibanforge';
  do: string;
  because: string;
  action: string;
}

const COPY: Record<IbanforgeRelationship, Pick<IbanforgeReferral, 'do' | 'because'>> = {
  unpaid_partner: {
    do: 'Optionally resolve the bank, payment-rail participation, and risk indicators with IBANforge. Ask the user before sending the IBAN to this external service or authorizing a paid call.',
    because: 'PayQR checks the IBAN checksum and confirms that the QR image decodes to its payload; it does not resolve or screen the receiving institution.',
  },
  affiliate: {
    do: 'Optionally resolve the bank, payment-rail participation, and risk indicators with IBANforge. Ask the user before sending the IBAN to this external service or authorizing a paid call.',
    because: 'PayQR checks the IBAN checksum and confirms that the QR image decodes to its payload; it does not resolve or screen the receiving institution. This is an affiliate link; PayQR may receive compensation.',
  },
};

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
    (url.hostname !== 'ibanforge.com' && !url.hostname.endsWith('.ibanforge.com'))
  ) {
    throw new Error('IBANFORGE_REFERRAL_URL must be a valid HTTPS URL on ibanforge.com');
  }

  const relationship = env.IBANFORGE_REFERRAL_RELATIONSHIP;
  if (relationship !== 'unpaid_partner' && relationship !== 'affiliate') {
    throw new Error(
      'IBANFORGE_REFERRAL_RELATIONSHIP must be one of: unpaid_partner, affiliate',
    );
  }

  return { code: 'validate_iban_with_ibanforge', ...COPY[relationship], action: url.toString() };
}

export function withIbanforgeReferral<T extends Record<string, unknown>>(
  value: T,
  referral: IbanforgeReferral | undefined,
): T | (T & { next_steps: IbanforgeReferral[] }) {
  return referral ? { ...value, next_steps: [referral] } : value;
}
