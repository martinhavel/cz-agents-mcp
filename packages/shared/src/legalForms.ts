import legalForms from './codebooks/legal-forms.json' with { type: 'json' };

const LEGAL_FORMS: Record<string, string> = legalForms;

export function resolveLegalForm(code?: string): string | undefined {
  if (code == null) return undefined;
  const value = code.trim();
  if (!value) return undefined;
  if (!/^\d+$/.test(value)) return value;
  return LEGAL_FORMS[value] ?? value;
}
