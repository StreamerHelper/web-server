import { RewriteDouyinAuthState1700000000006 } from '../../src/migration/1700000000006-RewriteDouyinAuthState';

describe('RewriteDouyinAuthState migration', () => {
  it('clears legacy Cookie values before enforcing the no-secret constraint', async () => {
    const queries: string[] = [];
    const queryRunner = {
      query: jest.fn(async (query: string) => {
        queries.push(query.replace(/\s+/g, ' ').trim());
      }),
    };

    await new RewriteDouyinAuthState1700000000006().up(queryRunner as any);

    const relaxIndex = queries.findIndex(query =>
      query.includes('ALTER COLUMN "cookie_header" DROP NOT NULL')
    );
    const clearIndex = queries.findIndex(query =>
      query.includes('"cookie_header" = NULL')
    );
    const enforceNullIndex = queries.findIndex(query =>
      query.includes(
        'ADD CONSTRAINT "CHK_douyin_credentials_cookie_header_null"'
      )
    );

    expect(relaxIndex).toBeGreaterThanOrEqual(0);
    expect(clearIndex).toBeGreaterThan(relaxIndex);
    expect(enforceNullIndex).toBeGreaterThan(clearIndex);
  });

  it('drops the no-secret constraint before restoring the legacy schema', async () => {
    const queries: string[] = [];
    const queryRunner = {
      query: jest.fn(async (query: string) => {
        queries.push(query.replace(/\s+/g, ' ').trim());
      }),
    };

    await new RewriteDouyinAuthState1700000000006().down(queryRunner as any);

    expect(queries[0]).toContain(
      'DROP CONSTRAINT IF EXISTS "CHK_douyin_credentials_cookie_header_null"'
    );
    expect(
      queries.findIndex(query =>
        query.includes('ALTER COLUMN "cookie_header" SET NOT NULL')
      )
    ).toBeGreaterThan(0);
  });
});
