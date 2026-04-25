/**
 * Name normalization for fuzzy matching:
 *  - lowercase
 *  - strip diacritics
 *  - transliterate common cyrillic / arabic / chinese scripts
 *  - collapse whitespace
 *  - drop punctuation
 *
 * Designed for *match keys*, not for display. Original spelling is preserved
 * elsewhere (primary_name, aliases).
 */

// Minimal cyrillic → latin transliteration covering names found on EU/OFAC lists.
// Not BGN/PCGN-strict — close enough for fuzzy matching.
const CYRILLIC: Record<string, string> = {
  а: 'a', б: 'b', в: 'v', г: 'g', д: 'd', е: 'e', ё: 'yo', ж: 'zh', з: 'z',
  и: 'i', й: 'y', к: 'k', л: 'l', м: 'm', н: 'n', о: 'o', п: 'p', р: 'r',
  с: 's', т: 't', у: 'u', ф: 'f', х: 'kh', ц: 'ts', ч: 'ch', ш: 'sh', щ: 'shch',
  ъ: '', ы: 'y', ь: '', э: 'e', ю: 'yu', я: 'ya',
  // Ukrainian / Belarusian extras
  і: 'i', ї: 'yi', є: 'ye', ў: 'w', ґ: 'g',
};

export function normalizeName(input: string): string {
  if (!input) return '';
  let s = input.toLowerCase();

  // transliterate cyrillic char-by-char
  let out = '';
  for (const ch of s) {
    out += CYRILLIC[ch] ?? ch;
  }
  s = out;

  // strip diacritics (combining marks)
  s = s.normalize('NFKD').replace(/[̀-ͯ]/g, '');

  // replace punctuation with space
  s = s.replace(/[.,/#!$%^&*;:{}=\-_`~()'"\[\]\\]/g, ' ');

  // collapse whitespace
  s = s.replace(/\s+/g, ' ').trim();

  return s;
}

/**
 * Token-set: split, drop dupes, sort. Lets "John Smith" match "Smith, John".
 */
export function tokenSet(input: string): string[] {
  const norm = normalizeName(input);
  if (!norm) return [];
  return Array.from(new Set(norm.split(' ').filter((t) => t.length > 0))).sort();
}
