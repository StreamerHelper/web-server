import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddDouyinCredentials1700000000005 implements MigrationInterface {
  name = 'AddDouyinCredentials1700000000005';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "douyin_credentials" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "cookie_header" text NOT NULL,
        "cookie_names" jsonb NOT NULL,
        "verified_at" TIMESTAMP WITH TIME ZONE,
        "last_validation_error" text,
        "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "PK_douyin_credentials_id" PRIMARY KEY ("id")
      )
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('DROP TABLE IF EXISTS "douyin_credentials"');
  }
}
