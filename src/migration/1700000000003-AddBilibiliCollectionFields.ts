import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddBilibiliCollectionFields1700000000003
  implements MigrationInterface
{
  name = 'AddBilibiliCollectionFields1700000000003';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "bilibili_submissions"
      ADD COLUMN IF NOT EXISTS "collection_auto_add" BOOLEAN DEFAULT false,
      ADD COLUMN IF NOT EXISTS "collection_season_id" BIGINT,
      ADD COLUMN IF NOT EXISTS "collection_section_id" BIGINT,
      ADD COLUMN IF NOT EXISTS "collection_season_title" VARCHAR(255),
      ADD COLUMN IF NOT EXISTS "collection_section_title" VARCHAR(255),
      ADD COLUMN IF NOT EXISTS "collection_episode_id" BIGINT,
      ADD COLUMN IF NOT EXISTS "collection_added_at" TIMESTAMPTZ
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "bilibili_submissions"
      DROP COLUMN IF EXISTS "collection_added_at",
      DROP COLUMN IF EXISTS "collection_episode_id",
      DROP COLUMN IF EXISTS "collection_section_title",
      DROP COLUMN IF EXISTS "collection_season_title",
      DROP COLUMN IF EXISTS "collection_section_id",
      DROP COLUMN IF EXISTS "collection_season_id",
      DROP COLUMN IF EXISTS "collection_auto_add"
    `);
  }
}
