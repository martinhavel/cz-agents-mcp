import { describe, expect, it } from 'vitest';
import { buildVrClient } from '../vr-client.js';
import { OWNERS_SQL } from '../vr-owners.js';

const VERIFIED_CORPORATE_OWNER_ICO = '00000795';
const VERIFIED_MEMBER_ICO = '25510851';

const hasVrEnv = Boolean(process.env.VR_DATABASE_URL || process.env.VR_PG_HOST);
const maybeIt = hasVrEnv ? it : it.skip;

describe('VR ownership integration', () => {
  it('does not configure a VR client when DB env is absent', () => {
    expect(buildVrClient({})).toBeUndefined();
  });

  maybeIt('returns a live corporate owner from OWNERS_SQL', async () => {
    const vr = buildVrClient();
    if (!vr) throw new Error('VR env expected for integration test');

    const result = await vr.query<{
      depth: number;
      owners: Array<{ kind: string; ico: string | null }> | string;
    }>(OWNERS_SQL, [VERIFIED_CORPORATE_OWNER_ICO, 5]);

    const root = result.rows.find((row) => row.depth === 0);
    expect(root).toBeDefined();

    const owners = typeof root!.owners === 'string'
      ? JSON.parse(root!.owners) as Array<{ kind: string; ico: string | null }>
      : root!.owners;

    expect(owners).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: 'company', ico: VERIFIED_MEMBER_ICO }),
      ]),
    );
  }, 120_000);
});
