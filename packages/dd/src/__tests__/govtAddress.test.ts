import { describe, it, expect } from 'vitest';
import { detectGovtAddress } from '../govtAddress.js';

describe('detectGovtAddress', () => {
  it('returns false for missing address', () => {
    expect(detectGovtAddress(undefined).is_govt_address).toBe(false);
  });

  it('detects "úřad" in textovaAdresa', () => {
    const r = detectGovtAddress({ textovaAdresa: 'Úřad městské části Praha 3, Havlíčkovo nám. 9, Praha' });
    expect(r.is_govt_address).toBe(true);
    expect(r.signal).toBe('marker');
  });

  it('detects "magistrát" marker', () => {
    const r = detectGovtAddress({ textovaAdresa: 'Magistrát hl. m. Prahy, Mariánské náměstí 2, Praha' });
    expect(r.is_govt_address).toBe(true);
    expect(r.signal).toBe('marker');
  });

  it('detects "městská část" marker case-insensitive, diacritics tolerant', () => {
    const r = detectGovtAddress({ textovaAdresa: 'mestska cast Praha 1, Vodičkova 1, Praha' });
    expect(r.is_govt_address).toBe(true);
  });

  it('detects known address from static list', () => {
    const r = detectGovtAddress({ textovaAdresa: 'Mariánské náměstí 2, Praha' });
    expect(r.is_govt_address).toBe(true);
    expect(r.signal).toBe('known_address');
  });

  it('returns false for normal residential address', () => {
    const r = detectGovtAddress({ textovaAdresa: 'Mratínská 566, 25085 Bašť' });
    expect(r.is_govt_address).toBe(false);
  });

  it('returns false for company virtual office (different signal)', () => {
    const r = detectGovtAddress({ textovaAdresa: 'Tržiště 366/13, Malá Strana, 11800 Praha 1' });
    expect(r.is_govt_address).toBe(false);
  });

  it('handles missing textovaAdresa with structured fields', () => {
    const r = detectGovtAddress({
      nazevUlice: 'Mariánské náměstí',
      cisloDomovni: 2,
      nazevObce: 'Praha',
    });
    expect(r.is_govt_address).toBe(true);
    expect(r.signal).toBe('known_address');
  });
});
