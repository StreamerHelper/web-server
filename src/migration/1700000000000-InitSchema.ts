import { MigrationInterface, QueryRunner } from 'typeorm';

export class InitSchema1700000000000 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    // 先删除已存在的类型和表（干净重建）
    await queryRunner.query('DROP TABLE IF EXISTS "jobs" CASCADE;');
    await queryRunner.query('DROP TABLE IF EXISTS "streamers" CASCADE;');
    await queryRunner.query(
      'DROP TABLE IF EXISTS "bilibili_credentials" CASCADE;'
    );
    await queryRunner.query(
      'DROP TABLE IF EXISTS "bilibili_submissions" CASCADE;'
    );
    await queryRunner.query('DROP TABLE IF EXISTS "migrations" CASCADE;');
    await queryRunner.query('DROP TYPE IF EXISTS "job_status_enum";');
    await queryRunner.query('DROP TYPE IF EXISTS "platform_enum";');
    await queryRunner.query('DROP TYPE IF EXISTS "submission_status";');
    await queryRunner.query('DROP TYPE IF EXISTS "part_status";');

    // 创建枚举类型
    await queryRunner.query(`
      CREATE TYPE "platform_enum" AS ENUM ('bilibili', 'huya', 'douyu');
    `);

    await queryRunner.query(`
      CREATE TYPE "job_status_enum" AS ENUM ('pending', 'recording', 'processing', 'completed', 'failed', 'cancelled', 'stopping');
    `);

    await queryRunner.query(`
      CREATE TYPE "submission_status" AS ENUM ('pending', 'uploading', 'submitting', 'completed', 'failed');
    `);

    await queryRunner.query(`
      CREATE TYPE "part_status" AS ENUM ('pending', 'merging', 'uploading', 'completed', 'failed');
    `);

    // 创建 streamers 表
    await queryRunner.query(`
      CREATE TABLE "streamers" (
        "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "streamer_id" VARCHAR(255) UNIQUE NOT NULL,
        "name" VARCHAR(255) NOT NULL,
        "platform" platform_enum NOT NULL,
        "room_id" VARCHAR(255) NOT NULL,
        "is_active" BOOLEAN DEFAULT true,
        "last_check_time" TIMESTAMPTZ,
        "last_live_time" TIMESTAMPTZ,
        "recordSettings" jsonb,
        "uploadSettings" jsonb,
        "created_at" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        "updated_at" TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);

    await queryRunner.query(`
      CREATE INDEX "IDX_streamer_id" ON "streamers" ("streamer_id");
    `);

    // 创建 jobs 表
    await queryRunner.query(`
      CREATE TABLE "jobs" (
        "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "job_id" VARCHAR(255) UNIQUE NOT NULL,
        "streamer_id" VARCHAR(255) NOT NULL,
        "streamer_name" VARCHAR(255) NOT NULL,
        "room_name" VARCHAR(500),
        "room_id" VARCHAR(255) NOT NULL,
        "platform" platform_enum NOT NULL,
        "streamUrl" VARCHAR(1000),
        "danmakuUrl" VARCHAR(1000),
        "status" job_status_enum DEFAULT 'pending',
        "metadata" jsonb,
        "video_path" VARCHAR(255),
        "danmaku_path" VARCHAR(255),
        "segment_count" INT DEFAULT 0,
        "duration" INT DEFAULT 0,
        "start_time" TIMESTAMPTZ,
        "end_time" TIMESTAMPTZ,
        "error_message" VARCHAR(255),
        "cover_url" VARCHAR(1000),
        "created_at" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        "updated_at" TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);

    await queryRunner.query(`
      CREATE INDEX "IDX_job_streamer_id" ON "jobs" ("streamer_id");
      CREATE INDEX "IDX_job_id" ON "jobs" ("job_id");
      CREATE INDEX "IDX_job_status" ON "jobs" ("status");
    `);

    // 创建 bilibili_credentials 表
    await queryRunner.query(`
      CREATE TABLE "bilibili_credentials" (
        "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "access_token" VARCHAR(256) NOT NULL,
        "refresh_token" VARCHAR(256) NOT NULL,
        "mid" BIGINT NOT NULL,
        "expires_at" TIMESTAMPTZ NOT NULL,
        "cookies" jsonb NOT NULL,
        "created_at" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        "updated_at" TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);

    // 创建 bilibili_submissions 表
    await queryRunner.query(`
      CREATE TABLE "bilibili_submissions" (
        "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "job_id" VARCHAR(255) NOT NULL,
        "title" VARCHAR(80) NOT NULL,
        "description" VARCHAR(2000),
        "tags" TEXT[],
        "tid" INTEGER DEFAULT 171,
        "cover" VARCHAR(500),
        "copyright" INTEGER DEFAULT 1,
        "source" VARCHAR(500),
        "dynamic" VARCHAR(500),
        "status" submission_status DEFAULT 'pending',
        "parts" JSONB NOT NULL DEFAULT '[]',
        "total_parts" INTEGER DEFAULT 0,
        "completed_parts" INTEGER DEFAULT 0,
        "bvid" VARCHAR(20),
        "avid" BIGINT,
        "last_error" VARCHAR(2000),
        "created_at" TIMESTAMPTZ DEFAULT NOW(),
        "updated_at" TIMESTAMPTZ DEFAULT NOW()
      );
    `);

    await queryRunner.query(`
      CREATE INDEX "IDX_bilibili_submissions_job_id" ON "bilibili_submissions" ("job_id");
      CREATE INDEX "IDX_bilibili_submissions_status" ON "bilibili_submissions" ("status");
    `);

    // 创建 migrations 记录表
    await queryRunner.query(`
      CREATE TABLE "migrations" (
        "id" SERIAL PRIMARY KEY,
        "timestamp" BIGINT NOT NULL,
        "name" VARCHAR(255) NOT NULL
      );
    `);

    // 记录此 migration 已执行
    await queryRunner.query(`
      INSERT INTO "migrations" ("timestamp", "name") VALUES (1700000000000, 'InitSchema1700000000000');
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('DROP TABLE IF EXISTS "jobs" CASCADE;');
    await queryRunner.query('DROP TABLE IF EXISTS "streamers" CASCADE;');
    await queryRunner.query(
      'DROP TABLE IF EXISTS "bilibili_credentials" CASCADE;'
    );
    await queryRunner.query(
      'DROP TABLE IF EXISTS "bilibili_submissions" CASCADE;'
    );
    await queryRunner.query('DROP TABLE IF EXISTS "migrations" CASCADE;');
    await queryRunner.query('DROP TYPE IF EXISTS "job_status_enum";');
    await queryRunner.query('DROP TYPE IF EXISTS "platform_enum";');
    await queryRunner.query('DROP TYPE IF EXISTS "submission_status";');
    await queryRunner.query('DROP TYPE IF EXISTS "part_status";');
  }
}
