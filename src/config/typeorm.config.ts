import * as path from 'path';
import * as process from 'process';
import { DataSource, DataSourceOptions } from 'typeorm';

// 编译后从 dist 加载时为 .js 路径，ts-node 开发时为 .ts 路径
const isCompiled =
  __dirname.includes(path.sep + 'dist' + path.sep) ||
  __dirname.endsWith(path.sep + 'dist');

const entityPattern = isCompiled
  ? path.join(__dirname, '..', 'entity', '**', '*.entity.js')
  : 'src/entity/**/*.entity.ts';

const migrationPattern = isCompiled
  ? path.join(__dirname, '..', 'migration', '**', '*.js')
  : 'src/migration/**/*.ts';

const options: DataSourceOptions = {
  type: 'postgres',
  // 兼容两套环境变量：DB_*（新）和 TYPEORM_*（旧）
  host: process.env.DB_HOST || process.env.TYPEORM_HOST || 'localhost',
  port: parseInt(
    process.env.DB_PORT || process.env.TYPEORM_PORT || '5432',
    10
  ),
  username:
    process.env.DB_USER || process.env.TYPEORM_USERNAME || 'postgres',
  password:
    process.env.DB_PASSWORD || process.env.TYPEORM_PASSWORD || 'postgres',
  database:
    process.env.DB_NAME || process.env.TYPEORM_DATABASE || 'streamerhelper',
  entities: [entityPattern],
  migrations: [migrationPattern],
  logging: true,
};

export default new DataSource(options);
