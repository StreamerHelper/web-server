/**
 * 生产环境迁移入口：以编译后的 JS 运行，不依赖 ts-node。
 * 使用方式：node dist/scripts/run-migrations.js
 */
import dataSource from './typeorm-cli.datasource';

async function main(): Promise<void> {
  await dataSource.initialize();
  const run = await dataSource.runMigrations();
  await dataSource.destroy();
  if (run.length > 0) {
    console.log('Executed migrations:', run.map((m) => m.name).join(', '));
  } else {
    console.log('No pending migrations.');
  }
}

// 只在直接运行此文件时执行 main()，被导入时不执行
if (require.main === module) {
  main().catch((err) => {
    console.error('Migration failed:', err);
    process.exit(1);
  });
}

export { main as runMigrations };
