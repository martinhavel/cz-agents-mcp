import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { lookupGleifByRegistrationNumber, lookupGleifParent, getByLei } from '../gleif-lookup.js';

type FetchArgs = Parameters<typeof fetch>;

function gleifResponse(records: unknown[], status = 200): Response {
  return new Response(JSON.stringify({ data: records }), {
    status,
    headers: { 'Content-Type': 'application/vnd.api+json' },
  });
}

function gleifSingleResponse(record: unknown, status = 200): Response {
  return new Response(JSON.stringify({ data: record }), {
    status,
    headers: { 'Content-Type': 'application/vnd.api+json' },
  });
}

function makeRecord(lei: string, name: string, jurisdiction = 'DE') {
  return {
    id: lei,
    attributes: {
      entity: {
        legalName: { name },
        jurisdiction,
      },
    },
  };
}

describe('lookupGleifParent', () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    fetchSpy = vi.spyOn(globalThis, 'fetch');
  });

  afterEach(() => {
    fetchSpy.mockRestore();
  });

  it('returns HIGH confidence on exact name match (after suffix strip)', async () => {
    fetchSpy.mockResolvedValue(
      gleifResponse([makeRecord('529900T8BM49AURSDO55', 'Siemens AG')]),
    );

    const result = await lookupGleifParent('Siemens s.r.o.');
    expect(result).not.toBeNull();
    expect(result?.confidence).toBe('HIGH');
    expect(result?.lei).toBe('529900T8BM49AURSDO55');
    expect(result?.name).toBe('Siemens AG');
  });

  it('returns MEDIUM confidence when czech name contains gleif name', async () => {
    fetchSpy.mockResolvedValue(
      gleifResponse([makeRecord('LEI123', 'Bosch')]),
    );

    const result = await lookupGleifParent('Bosch Service Solutions s.r.o.');
    expect(result?.confidence).toBe('MEDIUM');
  });

  it('calls GLEIF API with fulltext filter', async () => {
    let capturedUrl = '';
    fetchSpy.mockImplementation((async (...args: FetchArgs) => {
      capturedUrl = args[0] instanceof URL ? args[0].toString() : String(args[0]);
      return gleifResponse([makeRecord('X', 'Test Corp')]);
    }) as typeof fetch);

    await lookupGleifParent('Test Company');
    expect(capturedUrl).toContain('api.gleif.org/api/v1/lei-records');
    expect(capturedUrl).toContain('filter%5Bfulltext%5D=Test+Company');
    expect(capturedUrl).toContain('page%5Bsize%5D=5');
  });

  it('returns null when no records', async () => {
    fetchSpy.mockResolvedValue(gleifResponse([]));
    await expect(lookupGleifParent('NonExistent XYZ 123')).resolves.toBeNull();
  });

  it('returns null on network error without throwing', async () => {
    fetchSpy.mockRejectedValue(new Error('network failed'));
    await expect(lookupGleifParent('SomeCorp')).resolves.toBeNull();
  });

  it('returns null when score is zero (unrelated name)', async () => {
    fetchSpy.mockResolvedValue(
      gleifResponse([makeRecord('ABC', 'Volkswagen AG')]),
    );
    // "Xyzu" has zero word overlap with "Volkswagen"
    const result = await lookupGleifParent('Xyzu a.s.');
    expect(result).toBeNull();
  });
});

describe('getByLei', () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    fetchSpy = vi.spyOn(globalThis, 'fetch');
  });

  afterEach(() => {
    fetchSpy.mockRestore();
  });

  it('fetches /lei-records/{lei} and maps to GleifFullRecord', async () => {
    let capturedUrl = '';
    fetchSpy.mockImplementation((async (...args: Parameters<typeof fetch>) => {
      capturedUrl = args[0] instanceof URL ? args[0].toString() : String(args[0]);
      return gleifSingleResponse({
        id: 'W38RGI023J3WT1HWRP32',
        attributes: {
          entity: {
            legalName: { name: 'Siemens AG' },
            status: 'ACTIVE',
            jurisdiction: 'DE',
            registeredAs: 'HRB 6684',
            creationDate: '1996-08-27T22:00:00Z',
            legalAddress: { addressLines: ['Werner-von-Siemens-Str. 1'], city: 'München', postalCode: '80333' },
          },
        },
      });
    }) as typeof fetch);

    const record = await getByLei('W38RGI023J3WT1HWRP32');

    expect(capturedUrl).toContain('/lei-records/W38RGI023J3WT1HWRP32');
    expect(record?.lei).toBe('W38RGI023J3WT1HWRP32');
    expect(record?.name).toBe('Siemens AG');
    expect(record?.status).toBe('active');
    expect(record?.country).toBe('de');
    expect(record?.registered_as).toBe('HRB 6684');
    expect(record?.created_on).toBe('1996-08-27');
  });

  it('returns null on non-200 response', async () => {
    fetchSpy.mockResolvedValue(gleifSingleResponse({}, 404));
    await expect(getByLei('BADLEI')).resolves.toBeNull();
  });

  it('returns null on network error', async () => {
    fetchSpy.mockRejectedValue(new Error('timeout'));
    await expect(getByLei('ANYLEI')).resolves.toBeNull();
  });
});

describe('lookupGleifByRegistrationNumber', () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    fetchSpy = vi.spyOn(globalThis, 'fetch');
  });

  afterEach(() => {
    fetchSpy.mockRestore();
  });

  it('calls GLEIF registeredAs filter and returns the best name match', async () => {
    let capturedUrl = '';
    fetchSpy.mockImplementation((async (...args: FetchArgs) => {
      capturedUrl = args[0] instanceof URL ? args[0].toString() : String(args[0]);
      return gleifResponse([
        makeRecord('PENSION', 'HILTI PENSIONSKASSE', 'CH'),
        {
          ...makeRecord('HILTIAG', 'Hilti Aktiengesellschaft', 'LI'),
          attributes: {
            entity: {
              legalName: { name: 'Hilti Aktiengesellschaft' },
              jurisdiction: 'LI',
              registeredAs: 'FL-0001.011.557-0',
            },
          },
        },
      ]);
    }) as typeof fetch);

    const result = await lookupGleifByRegistrationNumber('FL-0001.011.557-0', 'Hilti Aktiengesellschaft');

    expect(capturedUrl).toContain('filter%5Bentity.registeredAs%5D=FL-0001.011.557-0');
    expect(result).toMatchObject({
      lei: 'HILTIAG',
      name: 'Hilti Aktiengesellschaft',
      country: 'li',
      registered_as: 'FL-0001.011.557-0',
    });
  });
});
