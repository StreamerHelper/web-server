import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddBilibiliHumanType21700000000004
  implements MigrationInterface
{
  name = 'AddBilibiliHumanType21700000000004';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "bilibili_submissions"
      ADD COLUMN IF NOT EXISTS "human_type2" INTEGER DEFAULT 2066
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "bilibili_submissions"
      DROP COLUMN IF EXISTS "human_type2"
    `);
  }
}
