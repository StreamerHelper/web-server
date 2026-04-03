/**
 * Configuration Loader
 *
 * 配置优先级：环境变量 > 配置文件(settings.json) > 默认值
 *
 * 配置文件搜索路径（按优先级）：
 * 1. CONFIG_DIR 环境变量指定的目录
 * 2. 项目根目录的 settings.json (仅开发模式: NODE_ENV=local 或 development)
 * 3. /app/config (Docker 容器内)
 * 4. 当前工作目录下的 config/settings.json (本地开发)
 * 5. ~/.streamer-helper/settings.json (默认)
 */

import * as fs from 'fs';
import { merge } from 'lodash';
import * as os from 'os';
import * as path from 'path';

// 配置文件名
const CONFIG_FILENAME = 'settings.json';

/**
 * 判断是否为开发模式
 */
function isDevMode(): boolean {
  const nodeEnv = process.env.NODE_ENV;
  return nodeEnv === 'local' || nodeEnv === 'development';
}

/**
 * 获取配置目录
 * 优先级：环境变量 > 项目根目录(dev模式) > /app/config > ./config > ~/.streamer-helper
 */
function getConfigDir(): string {
  // 1. 环境变量指定
  if (process.env.CONFIG_DIR) {
    return process.env.CONFIG_DIR;
  }

  // 2. 开发模式：优先读取项目根目录的 settings.json
  if (isDevMode()) {
    const projectRootConfig = path.join(process.cwd(), CONFIG_FILENAME);
    if (fs.existsSync(projectRootConfig)) {
      return process.cwd();
    }
  }

  // 3. Docker 容器内
  if (fs.existsSync('/app/config')) {
    return '/app/config';
  }

  // 4. 本地开发：当前工作目录下的 config 目录
  const localConfigDir = path.join(process.cwd(), 'config');
  if (fs.existsSync(localConfigDir)) {
    return localConfigDir;
  }

  // 5. 默认：用户主目录
  return path.join(os.homedir(), '.streamer-helper');
}

const CONFIG_DIR = getConfigDir();
const CONFIG_JSON = path.join(CONFIG_DIR, CONFIG_FILENAME);

/** 当前实际使用的配置文件路径 */
function getConfigFilePath(): string {
  return CONFIG_JSON;
}

// 配置接口定义
export interface AppConfig {
  app: {
    nodeEnv: 'development' | 'production' | 'test' | 'local';
    port: number;
    keys: string;
  };
  database: {
    host: string;
    port: number;
    username: string;
    password: string;
    database: string;
    ssl: boolean;
  };
  redis: {
    host: string;
    port: number;
    password: string;
    db: number;
  };
  s3: {
    endpoint: string;
    publicEndpoint: string;
    region: string;
    accessKey: string;
    secretKey: string;
    bucket: string;
  };
  recorder: {
    segmentDuration: number;
    cacheMaxSegments: number;
    heartbeatInterval: number;
    heartbeatTimeout: number;
    maxRecordingTime: number;
  };
  poller: {
    checkInterval: number;
    totalInstances: number;
    concurrency: number;
  };
  upload: {
    defaultTid: number;
    defaultTitleTemplate: string;
  };
}

// 默认配置
const DEFAULT_CONFIG: AppConfig = {
  app: {
    nodeEnv: 'development',
    port: 7001,
    keys: 'dev_default_key_please_change_in_production',
  },
  database: {
    host: 'localhost',
    port: 5432,
    username: 'postgres',
    password: 'postgres',
    database: 'streamerhelper',
    ssl: false,
  },
  redis: {
    host: 'localhost',
    port: 6379,
    password: '',
    db: 0,
  },
  s3: {
    endpoint: 'http://minio:9000',
    publicEndpoint: 'http://localhost:9000',
    region: 'us-east-1',
    accessKey: 'minioadmin',
    secretKey: 'minioadmin',
    bucket: 'streamerhelper-archive',
  },
  recorder: {
    segmentDuration: 10,
    cacheMaxSegments: 3,
    heartbeatInterval: 5,
    heartbeatTimeout: 10,
    maxRecordingTime: 86400,
  },
  poller: {
    checkInterval: 60,
    totalInstances: 1,
    concurrency: 5,
  },
  upload: {
    defaultTid: 171,
    defaultTitleTemplate: '{streamerName}的直播录像 {date}',
  },
};

/**
 * 从环境变量读取配置覆盖
 */
function getEnvOverrides(): Partial<AppConfig> {
  const overrides: Partial<AppConfig> = {};

  // App
  if (process.env.NODE_ENV) {
    overrides.app = {
      ...overrides.app,
      nodeEnv: process.env.NODE_ENV as AppConfig['app']['nodeEnv'],
    };
  }
  if (process.env.APP_PORT) {
    overrides.app = { ...overrides.app, port: parseInt(process.env.APP_PORT, 10) };
  }
  if (process.env.APP_KEYS) {
    overrides.app = { ...overrides.app, keys: process.env.APP_KEYS };
  }

  // Database
  if (process.env.TYPEORM_HOST) {
    overrides.database = { ...overrides.database, host: process.env.TYPEORM_HOST };
  }
  if (process.env.TYPEORM_PORT) {
    overrides.database = { ...overrides.database, port: parseInt(process.env.TYPEORM_PORT, 10) };
  }
  if (process.env.TYPEORM_USERNAME) {
    overrides.database = { ...overrides.database, username: process.env.TYPEORM_USERNAME };
  }
  if (process.env.TYPEORM_PASSWORD) {
    overrides.database = { ...overrides.database, password: process.env.TYPEORM_PASSWORD };
  }
  if (process.env.TYPEORM_DATABASE) {
    overrides.database = { ...overrides.database, database: process.env.TYPEORM_DATABASE };
  }
  if (process.env.TYPEORM_SSL) {
    overrides.database = { ...overrides.database, ssl: process.env.TYPEORM_SSL === 'true' };
  }

  // Redis
  if (process.env.REDIS_HOST) {
    overrides.redis = { ...overrides.redis, host: process.env.REDIS_HOST };
  }
  if (process.env.REDIS_PORT) {
    overrides.redis = { ...overrides.redis, port: parseInt(process.env.REDIS_PORT, 10) };
  }
  if (process.env.REDIS_PASSWORD) {
    overrides.redis = { ...overrides.redis, password: process.env.REDIS_PASSWORD };
  }
  if (process.env.REDIS_DB) {
    overrides.redis = { ...overrides.redis, db: parseInt(process.env.REDIS_DB, 10) };
  }

  // S3
  if (process.env.S3_ENDPOINT) {
    overrides.s3 = { ...overrides.s3, endpoint: process.env.S3_ENDPOINT };
  }
  if (process.env.S3_PUBLIC_ENDPOINT) {
    overrides.s3 = { ...overrides.s3, publicEndpoint: process.env.S3_PUBLIC_ENDPOINT };
  }
  if (process.env.S3_REGION) {
    overrides.s3 = { ...overrides.s3, region: process.env.S3_REGION };
  }
  if (process.env.S3_ACCESS_KEY) {
    overrides.s3 = { ...overrides.s3, accessKey: process.env.S3_ACCESS_KEY };
  }
  if (process.env.S3_SECRET_KEY) {
    overrides.s3 = { ...overrides.s3, secretKey: process.env.S3_SECRET_KEY };
  }
  if (process.env.S3_BUCKET) {
    overrides.s3 = { ...overrides.s3, bucket: process.env.S3_BUCKET };
  }

  return overrides;
}

/**
 * 确保配置目录存在
 */
function ensureConfigDir(): void {
  if (!fs.existsSync(CONFIG_DIR)) {
    fs.mkdirSync(CONFIG_DIR, { recursive: true });
  }
}

/**
 * 生成默认配置文件（JSON，便于工具与脚本解析）
 */
function generateDefaultConfigFile(): void {
  ensureConfigDir();
  const defaultContent: AppConfig = {
    ...DEFAULT_CONFIG,
    app: { ...DEFAULT_CONFIG.app, keys: generateRandomKey() },
  };
  const jsonContent = JSON.stringify(defaultContent, null, 2);
  fs.writeFileSync(CONFIG_JSON, jsonContent + '\n', 'utf-8');
  console.log(`[Config] Created default config file at: ${CONFIG_JSON}`);
}

/**
 * 生成随机密钥
 */
function generateRandomKey(): string {
  const { randomBytes } = require('crypto');
  return randomBytes(16).toString('hex');
}

/**
 * 从磁盘读取配置文件内容（JSON）
 */
function readConfigFile(filePath: string): Partial<AppConfig> {
  const content = fs.readFileSync(filePath, 'utf-8');
  return JSON.parse(content) as Partial<AppConfig>;
}

/**
 * 加载配置
 * 优先级：环境变量 > 配置文件(settings.json) > 默认值
 */
export function loadConfig(): AppConfig {
  const configPath = getConfigFilePath();
  if (!fs.existsSync(configPath)) {
    generateDefaultConfigFile();
  }

  const effectivePath = getConfigFilePath();
  let fileConfig: Partial<AppConfig> = {};
  try {
    fileConfig = readConfigFile(effectivePath);
    console.log(`[Config] Loaded config from: ${effectivePath}`);
  } catch (error) {
    console.warn(`[Config] Failed to read config file, using defaults: ${error}`);
  }

  const envOverrides = getEnvOverrides();
  const config = merge({}, DEFAULT_CONFIG, fileConfig, envOverrides);

  if (config.app.nodeEnv) {
    process.env.NODE_ENV = config.app.nodeEnv;
  }

  return config;
}

// 导出配置实例（单例）
let configInstance: AppConfig | null = null;

export function getConfig(): AppConfig {
  if (!configInstance) {
    configInstance = loadConfig();
  }
  return configInstance;
}

export function getConfigPath(): string {
  return getConfigFilePath();
}
