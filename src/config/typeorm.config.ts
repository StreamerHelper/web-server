import * as process from 'process';
import { DataSource, DataSourceOptions } from 'typeorm';

const options: DataSourceOptions = {
  type: 'postgres',
  host: process.env.DB_HOST || 'localhost',
  port: parseInt(process.env.DB_PORT || '5432'),
  username: process.env.DB_USER || 'postgres',
  password: process.env.DB_PASSWORD || 'postgres',
  database: process.env.DB_NAME || 'streamerhelper',
  entities: ['src/entity/**/*.entity.ts'],
  migrations: ['src/migration/**/*.ts'],
  logging: true,
};

export default new DataSource(options);
