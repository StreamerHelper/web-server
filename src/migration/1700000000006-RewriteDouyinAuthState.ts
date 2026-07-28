import { MigrationInterface, QueryRunner } from 'typeorm';

export class RewriteDouyinAuthState1700000000006 implements MigrationInterface {
  name = 'RewriteDouyinAuthState1700000000006';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "douyin_credentials"
        ADD COLUMN IF NOT EXISTS "slot" varchar(32),
        ADD COLUMN IF NOT EXISTS "state" varchar(32) NOT NULL DEFAULT 'unknown',
        ADD COLUMN IF NOT EXISTS "auth_expires_at" TIMESTAMP WITH TIME ZONE,
        ADD COLUMN IF NOT EXISTS "state_changed_at" TIMESTAMP WITH TIME ZONE,
        ADD COLUMN IF NOT EXISTS "last_validation_code" varchar(64),
        ADD COLUMN IF NOT EXISTS "operation_id" varchar(64),
        ADD COLUMN IF NOT EXISTS "generation" integer NOT NULL DEFAULT 0,
        ADD COLUMN IF NOT EXISTS "version" integer NOT NULL DEFAULT 1
    `);

    await queryRunner.query(`
      WITH ranked AS (
        SELECT "id", row_number() OVER (
          ORDER BY "updated_at" DESC, "created_at" DESC, "id"
        ) AS row_number
        FROM "douyin_credentials"
      )
      DELETE FROM "douyin_credentials"
      WHERE "id" IN (SELECT "id" FROM ranked WHERE row_number > 1)
    `);

    // Legacy rows require cookie_header. Relax that constraint before removing
    // credential values so the whole migration remains atomic.
    await queryRunner.query(`
      ALTER TABLE "douyin_credentials"
      ALTER COLUMN "cookie_header" DROP NOT NULL
    `);

    await queryRunner.query(`
      UPDATE "douyin_credentials"
      SET
        "slot" = 'default',
        "state" = 'unknown',
        "cookie_header" = NULL,
        "verified_at" = NULL,
        "state_changed_at" = now(),
        "operation_id" = NULL,
        "generation" = 0,
        "last_validation_code" = 'PROFILE_MIGRATION_REQUIRED',
        "last_validation_error" =
          'Persistent browser login is required after the authentication upgrade'
    `);

    // The previous backend may remain online while migrations run. Enforce the
    // new no-secret invariant in PostgreSQL so it cannot write a Cookie value
    // back after this migration has cleared the legacy row.
    await queryRunner.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (
          SELECT 1
          FROM pg_constraint
          WHERE conname = 'CHK_douyin_credentials_cookie_header_null'
            AND conrelid = 'douyin_credentials'::regclass
        ) THEN
          ALTER TABLE "douyin_credentials"
          ADD CONSTRAINT "CHK_douyin_credentials_cookie_header_null"
          CHECK ("cookie_header" IS NULL);
        END IF;
      END
      $$;
    `);

    await queryRunner.query(`
      ALTER TABLE "douyin_credentials"
        ALTER COLUMN "slot" SET DEFAULT 'default',
        ALTER COLUMN "slot" SET NOT NULL
    `);

    await queryRunner.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS "UQ_douyin_credentials_slot"
      ON "douyin_credentials" ("slot")
    `);

    await queryRunner.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (
          SELECT 1
          FROM pg_constraint
          WHERE conname = 'CHK_douyin_credentials_state'
            AND conrelid = 'douyin_credentials'::regclass
        ) THEN
          ALTER TABLE "douyin_credentials"
          ADD CONSTRAINT "CHK_douyin_credentials_state"
          CHECK (
            "state" IN (
              'unconfigured',
              'unknown',
              'validating',
              'valid',
              'challenged',
              'expired'
            )
          );
        END IF;
      END
      $$;
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "douyin_credentials"
      DROP CONSTRAINT IF EXISTS "CHK_douyin_credentials_cookie_header_null"
    `);
    await queryRunner.query(`
      ALTER TABLE "douyin_credentials"
      DROP CONSTRAINT IF EXISTS "CHK_douyin_credentials_state"
    `);
    await queryRunner.query(
      'DROP INDEX IF EXISTS "UQ_douyin_credentials_slot"'
    );
    await queryRunner.query(`
      DELETE FROM "douyin_credentials"
      WHERE "cookie_header" IS NULL
    `);
    await queryRunner.query(`
      ALTER TABLE "douyin_credentials"
        ALTER COLUMN "cookie_header" SET NOT NULL,
        DROP COLUMN IF EXISTS "version",
        DROP COLUMN IF EXISTS "generation",
        DROP COLUMN IF EXISTS "operation_id",
        DROP COLUMN IF EXISTS "last_validation_code",
        DROP COLUMN IF EXISTS "state_changed_at",
        DROP COLUMN IF EXISTS "auth_expires_at",
        DROP COLUMN IF EXISTS "state",
        DROP COLUMN IF EXISTS "slot"
    `);
  }
}
