import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('DD server pricing URL', () => {
  it('does not contain a doubled .html suffix', () => {
    const source = readFileSync(new URL('../server.ts', import.meta.url), 'utf8');
    expect(source).not.toContain('pricing.html.html');
  });
});
