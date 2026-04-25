import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddDouyinPlatform1700000000002 implements MigrationInterface {
  name = 'AddDouyinPlatform1700000000002';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TYPE "platform_enum"
      ADD VALUE IF NOT EXISTS 'douyin'
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    const rows = await queryRunner.query(`
      SELECT COUNT(*)::int AS count
      FROM (
        SELECT "platform"::text AS platform FROM "streamers"
        UNION ALL
        SELECT "platform"::text AS platform FROM "jobs"
      ) platforms
      WHERE platform = 'douyin'
    `);
    const count = Number(rows?.[0]?.count || 0);

    if (count > 0) {
      throw new Error(
        'Can not remove douyin from platform_enum while douyin rows exist'
      );
    }

    await queryRunner.query(`
      CREATE TYPE "platform_enum_old" AS ENUM ('bilibili', 'huya', 'douyu')
    `);
    await queryRunner.query(`
      ALTER TABLE "streamers"
      ALTER COLUMN "platform" TYPE "platform_enum_old"
      USING "platform"::text::"platform_enum_old"
    `);
    await queryRunner.query(`
      ALTER TABLE "jobs"
      ALTER COLUMN "platform" TYPE "platform_enum_old"
      USING "platform"::text::"platform_enum_old"
    `);
    await queryRunner.query('DROP TYPE "platform_enum"');
    await queryRunner.query(
      'ALTER TYPE "platform_enum_old" RENAME TO "platform_enum"'
    );
  }
}
