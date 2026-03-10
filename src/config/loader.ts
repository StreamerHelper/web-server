/**
 * Configuration Loader
 *
 * 配置优先级：环境变量 > 配置文件 > 默认值
 * 配置文件路径：~/.streamer_helper/config.yaml
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as yaml from 'js-yaml';
import { merge } from 'lodash';

// 配置目录和文件路径
// 优先级：环境变量 CONFIG_PATH > /app/config (Docker) > ~/.streamer_helper (本地开发)
const CONFIG_DIR = process.env.CONFIG_DIR ||
  (fs.existsSync('/app/config') ? '/app/config' : path.join(os.homedir(), '.streamer_helper'));
const CONFIG_FILE = path.join(CONFIG_DIR, 'config.yaml');

// 配置接口定义
export interface AppConfig {
  app: {
    nodeEnv: 'development' | 'production' | 'test';
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
    database: 'livestream',
    ssl: false,
  },
  redis: {
    host: 'localhost',
    port: 6379,
    password: '',
    db: 0,
  },
  s3: {
    endpoint: 'http://localhost:9000',
    region: 'us-east-1',
    accessKey: 'minioadmin',
    secretKey: 'minioadmin',
    bucket: 'livestream-archive',
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
 * 生成默认配置文件
 */
function generateDefaultConfigFile(): void {
  ensureConfigDir();

  const yamlContent = `# StreamerHelper Configuration
# 配置优先级：环境变量 > 配置文件 > 默认值
# 文档：https://github.com/StreamerHelper/web#配置说明

# ===========================================
# 应用配置
# ===========================================
app:
  nodeEnv: development    # development | production | test
  port: 7001
  keys: ${generateRandomKey()}  # Cookie 签名密钥，请妥善保管

# ===========================================
# 数据库配置 (PostgreSQL)
# ===========================================
database:
  host: localhost
  port: 5432
  username: postgres
  password: postgres
  database: livestream
  ssl: false              # 生产环境建议开启

# ===========================================
# Redis 配置
# ===========================================
redis:
  host: localhost
  port: 6379
  password: ""            # 无密码则留空
  db: 0

# ===========================================
# S3/MinIO 存储配置
# ===========================================
s3:
  endpoint: http://localhost:9000
  region: us-east-1
  accessKey: minioadmin
  secretKey: minioadmin
  bucket: livestream-archive

# ===========================================
# 录制器配置
# ===========================================
recorder:
  segmentDuration: 10        # 分片时长（秒）
  cacheMaxSegments: 3        # 最大缓存分片数
  heartbeatInterval: 5       # 心跳间隔（秒）
  heartbeatTimeout: 10       # 心跳超时（秒）
  maxRecordingTime: 86400    # 最大录制时长（秒），默认24小时

# ===========================================
# 轮询器配置
# ===========================================
poller:
  checkInterval: 60          # 检查直播状态间隔（秒）
  totalInstances: 1          # 实例数量
  concurrency: 5             # 并发检查数

# ===========================================
# 上传配置
# ===========================================
upload:
  defaultTid: 171            # 默认分区ID（电子竞技）
  defaultTitleTemplate: "{streamerName}的直播录像 {date}"
`;

  fs.writeFileSync(CONFIG_FILE, yamlContent, 'utf-8');
  console.log(`[Config] Created default config file at: ${CONFIG_FILE}`);
}

/**
 * 生成随机密钥
 */
function generateRandomKey(): string {
  const { randomBytes } = require('crypto');
  return randomBytes(16).toString('hex');
}

/**
 * 加载配置
 * 优先级：环境变量 > 配置文件 > 默认值
 */
export function loadConfig(): AppConfig {
  // 检查配置文件是否存在
  if (!fs.existsSync(CONFIG_FILE)) {
    generateDefaultConfigFile();
  }

  // 读取配置文件
  let fileConfig: Partial<AppConfig> = {};
  try {
    const content = fs.readFileSync(CONFIG_FILE, 'utf-8');
    fileConfig = yaml.load(content) as Partial<AppConfig>;
    console.log(`[Config] Loaded config from: ${CONFIG_FILE}`);
  } catch (error) {
    console.warn(`[Config] Failed to read config file, using defaults: ${error}`);
  }

  // 获取环境变量覆盖
  const envOverrides = getEnvOverrides();

  // 使用 lodash merge 深度合并配置
  const config = merge({}, DEFAULT_CONFIG, fileConfig, envOverrides);

  // 设置 NODE_ENV 环境变量（确保 MidwayJS 能正确识别）
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
  return CONFIG_FILE;
}
