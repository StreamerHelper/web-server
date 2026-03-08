import { MidwayConfig } from '@midwayjs/core';

export default {
  // use for cookie sign key, should change to your own and keep security
  keys: '1769452436380_8289',

  koa: {
    port: 7001,
  },

  // TypeORM 配置
  typeorm: {
    dataSource: {
      default: {
        type: 'postgres',
        host: 'localhost',
        port: 5432,
        username: 'postgres',
        password: 'postgres',
        database: 'livestream',
        ssl: false,
        entities: ['**/entity/*.entity{.ts,.js}'],
        synchronize: false,
        migrations: ['dist/migration/**/*.js'],
        logging: false,
        extra: {
          timezone: 'UTC',
        },
      },
    },
  },

  // BullMQ 配置
  bullmq: {
    defaultConnection: {
      host: 'localhost',
      port: 6379,
      password: undefined,
      db: 0,
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
      endpoint: 'http://localhost:9000',
      region: 'us-east-1',
      credentials: {
        accessKeyId: 'minioadmin',
        secretAccessKey: 'minioadmin',
      },
      bucket: 'livestream-archive',
      forcePathStyle: true,
    },

    // Redis 配置
    redis: {
      host: 'localhost',
      port: 6379,
      password: undefined,
      db: 0,
      lockTTL: 300,
    },

    // 录制器配置
    recorder: {
      segmentDuration: 10, // 秒
      cacheMaxSegments: 3,
      heartbeatInterval: 5, // 秒 - 心跳发送间隔
      heartbeatTimeout: 10, // 秒 - 心跳超时时间
      maxRecordingTime: 24 * 60 * 60, // 秒 - 最长录制时间（24小时）
    },

    // 轮询器配置
    poller: {
      checkInterval: 60, // 秒
      totalInstances: 1,
      concurrency: 5,
    },

    // 日志配置
    logging: {
      level: 'debug',
      pretty: true,
    },
  },

  // 投稿配置
  submission: {
    defaultTid: 171, // 默认分区（电子竞技）
    defaultTitleTemplate: '{streamerName}的直播录像 {date}',
  },

  // 日志配置
  midwayLogger: {
    clients: {
      appLogger: {
        level: 'debug',
        fileLogName: 'livestream-app.log',
      },
      coreLogger: {
        level: 'warn',
        fileLogName: 'midway-core.log',
      },
    },
  },
} as MidwayConfig;
