import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddStreamerCoverPath1700000000001
  implements MigrationInterface
{
  name = 'AddStreamerCoverPath1700000000001';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "streamers"
      ADD COLUMN IF NOT EXISTS "cover_path" VARCHAR(1000)
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "streamers"
      DROP COLUMN IF EXISTS "cover_path"
    `);
  }
}
