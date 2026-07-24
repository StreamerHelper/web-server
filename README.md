# StreamerHelper Web Server

StreamerHelper 后端服务，基于 Midway.js 框架的直播录制与内容管理系统。

## 功能特性

- **直播录制** - 支持多平台直播流实时录制与分段
- **弹幕处理** - 弹幕采集、XML 解析、ASS 字幕生成
- **视频高光** - 基于 AI 的直播精彩片段自动提取
- **B站集成** - 投稿管理、视频上传、认证授权
- **ASR 字幕** - 自动语音识别生成字幕
- **任务队列** - 基于 BullMQ 的异步任务处理
- **统一通知** - 支持主动通知、日志级别捕获、通道扩展与重复告警抑制

## 技术栈

| 类别 | 技术 |
|------|------|
| 框架 | [Midway.js](https://midwayjs.org/) + Koa |
| 语言 | TypeScript |
| 数据库 | PostgreSQL + TypeORM |
| 缓存/队列 | Redis + BullMQ |
| 对象存储 | MinIO (S3 兼容) |
| 视频处理 | FFmpeg |
| 字幕生成 | ASS/ASR |

## 快速开始

### 环境要求

- Node.js >= 16.0.0
- Docker & Docker Compose

### 启动基础设施

```bash
docker compose -f docker-compose.dev.yml up -d
```

启动服务：
- PostgreSQL (localhost:5432)
- Redis (localhost:6379)
- MinIO (localhost:9000, Console: localhost:9001)

### 安装依赖

```bash
npm install
```

### 数据库迁移

```bash
npm run migration:run
```

### 启动开发服务器

```bash
npm run dev
```

服务将在 http://localhost:7001 启动。

## 配置

配置文件搜索顺序（按优先级）：

1. `CONFIG_DIR` 环境变量指定的目录
2. 项目根目录的 `settings.json`（仅开发模式）
3. `/app/config`（Docker 容器内）
4. `./config/settings.json`（本地开发）
5. `~/.streamer-helper/settings.json`（默认）

### 默认服务凭证

| 服务 | 用户名 | 密码 |
|------|--------|------|
| PostgreSQL | postgres | postgres |
| MinIO | minioadmin | minioadmin |
| pgAdmin | admin@streamerhelper.dev | admin |

### 统一通知

`NoticeService` 支持业务代码主动发送通知，也会通过 Midway logger
Transport 捕获指定级别的日志。通知失败只会写入独立内部日志，不会中断业务。

```json
{
  "notice": {
    "enabled": true,
    "appName": "StreamerHelper",
    "maxContentLength": 4000,
    "logger": {
      "enabled": true,
      "level": "error",
      "fatigueSeconds": 300
    },
    "channels": {
      "serverChan": {
        "enabled": true,
        "sendKey": "",
        "endpoint": "",
        "timeoutMs": 10000
      }
    }
  }
}
```

生产环境推荐用 `SERVERCHAN_SENDKEY` 环境变量保存 SendKey。Server酱 Turbo
与 Server酱³ 的 API 地址会根据 SendKey 自动选择。还可以使用
`NOTICE_ENABLED`、`NOTICE_LOGGER_ENABLED`、`NOTICE_LOGGER_LEVEL` 和
`NOTICE_LOGGER_FATIGUE_SECONDS` 覆盖对应配置。旧的
`NOTICE_LOGGER_COOLDOWN_SECONDS` 仍可兼容读取。

业务代码可以直接注入服务：

```ts
@Inject()
noticeService: NoticeService;

await this.noticeService.send({
  title: '录制完成',
  content: '主播 feel 的录制和投稿处理已完成',
  level: 'info',
  dedupeKey: 'recording-completed:job-id',
  fatigueSeconds: 300,
});
```

邮件、短信等新渠道只需实现 `NoticeChannel` 的 `send()` 方法，再通过
`noticeService.registerChannel()` 注册，不需要修改 logger 接入层。

## 常用命令

```bash
# 开发
npm run dev              # 启动开发服务器
npm run build            # 构建生产版本
npm run start            # 启动生产服务器

# 数据库迁移
npm run migration:show   # 查看迁移状态
npm run migration:run    # 运行迁移
npm run migration:revert # 回滚迁移

# 测试
npm run test             # 运行测试
npm run cov              # 测试覆盖率

# 代码检查
npm run lint             # ESLint 检查
npm run lint:fix         # 自动修复
```

## Docker 服务

```bash
# 启动所有服务
docker compose -f docker-compose.dev.yml up -d

# 查看状态
docker compose -f docker-compose.dev.yml ps

# 查看日志
docker compose -f docker-compose.dev.yml logs -f

# 停止服务
docker compose -f docker-compose.dev.yml down

# 停止并删除数据
docker compose -f docker-compose.dev.yml down -v
```

## 工程结构

```
web-server/
├── src/
│   ├── config/          # 配置加载器
│   ├── controller/      # API 控制器
│   ├── entity/          # 数据库实体
│   ├── interface/       # 类型定义
│   ├── migration/       # 数据库迁移
│   ├── platform/        # 平台适配器
│   ├── processor/       # 业务处理器
│   ├── repository/      # 数据访问层
│   ├── scripts/         # 工具脚本
│   └── service/         # 业务服务
├── config/              # 配置文件
├── docker-compose.dev.yml
├── settings.json        # 本地开发配置
└── package.json
```

## 服务地址

| 服务 | 地址 |
|------|------|
| API | http://localhost:7001 |
| PostgreSQL | localhost:5432 |
| Redis | localhost:6379 |
| MinIO API | http://localhost:9000 |
| MinIO Console | http://localhost:9001 |
| pgAdmin | http://localhost:5050 |
