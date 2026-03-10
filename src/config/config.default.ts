import { MidwayConfig } from '@midwayjs/core';
import { getConfig } from './loader';

// 加载配置
const config = getConfig();
const isProduction = config.app.nodeEnv === 'production';

export default {
  // Cookie 签名密钥
  keys: config.app.keys,

  koa: {
    port: config.app.port,
  },

  // TypeORM 配置
  typeorm: {
    dataSource: {
      default: {
        type: 'postgres',
        host: config.database.host,
        port: config.database.port,
        username: config.database.username,
        password: config.database.password,
        database: config.database.database,
        ssl: config.database.ssl,
        entities: ['**/entity/*.entity{.ts,.js}'],
        synchronize: false,
        migrations: ['dist/migration/**/*.js'],
        migrationsRun: isProduction,
        logging: !isProduction,
        extra: {
          timezone: 'UTC',
        },
      },
    },
  },

  // BullMQ 配置
  bullmq: {
    defaultConnection: {
      host: config.redis.host,
      port: config.redis.port,
      password: config.redis.password || undefined,
      db: config.redis.db,
    },
    defaultPrefix: '{livestream}',
    defaultQueueOptions: {
      defaultJobOptions: {
        removeOnComplete: 10,
        removeOnFail: 50,
        attempts: 0,
        backoff: {
          type: 'exponential',
          delay: 1000,
        },
      },
    },
    // FlowProducer 配置
    flowProducer: {
      name: 'recording-flow',
    },
  },

  livestream: {
    // S3/MinIO 配置
    s3: {
      endpoint: config.s3.endpoint,
      region: config.s3.region,
      credentials: {
        accessKeyId: config.s3.accessKey,
        secretAccessKey: config.s3.secretKey,
      },
      bucket: config.s3.bucket,
      forcePathStyle: true,
    },

    // Redis 配置
    redis: {
      host: config.redis.host,
      port: config.redis.port,
      password: config.redis.password || undefined,
      db: config.redis.db,
      lockTTL: 300,
    },

    // 录制器配置
    recorder: {
      segmentDuration: config.recorder.segmentDuration,
      cacheMaxSegments: config.recorder.cacheMaxSegments,
      heartbeatInterval: config.recorder.heartbeatInterval,
      heartbeatTimeout: config.recorder.heartbeatTimeout,
      maxRecordingTime: config.recorder.maxRecordingTime,
    },

    // 轮询器配置
    poller: {
      checkInterval: config.poller.checkInterval,
      totalInstances: config.poller.totalInstances,
      concurrency: config.poller.concurrency,
    },

    // 日志配置
    logging: {
      level: isProduction ? 'info' : 'debug',
      pretty: !isProduction,
    },
  },

  // 投稿配置
  submission: {
    defaultTid: config.upload.defaultTid,
    defaultTitleTemplate: config.upload.defaultTitleTemplate,
  },

  // 日志配置
  midwayLogger: {
    clients: {
      appLogger: {
        level: isProduction ? 'info' : 'debug',
        fileLogName: 'livestream-app.log',
      },
      coreLogger: {
        level: 'warn',
        fileLogName: 'midway-core.log',
      },
    },
  },
} as MidwayConfig;
