import { normalizePagination } from '../../src/utils/pagination';

describe('normalizePagination', () => {
  it('uses the endpoint default when values are missing or invalid', () => {
    expect(normalizePagination(undefined, undefined, 24)).toEqual({
      limit: 24,
      offset: 0,
    });
    expect(normalizePagination('invalid', '-1', 50)).toEqual({
      limit: 50,
      offset: 0,
    });
  });

  it('clamps page size while preserving a valid offset', () => {
    expect(normalizePagination('1000', '48', 24)).toEqual({
      limit: 100,
      offset: 48,
    });
  });
});
