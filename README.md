# StreamerHelper Web Server

StreamerHelper 的后端服务，负责直播状态轮询、录制与媒体处理、任务调度、对象存储、B 站投稿和外部平台认证。

[本地开发](#本地开发) · [系统边界](#系统边界) · [配置](#配置) · [通知](#通知) · [命令参考](#命令参考) · [生产部署](#生产部署)

完整产品说明见 [StreamerHelper](https://github.com/StreamerHelper/StreamerHelper)，容器化部署由 [infra](https://github.com/StreamerHelper/infra) 管理。

## 系统边界

| 模块 | 职责 |
| --- | --- |
| 平台适配 | 读取 B 站、虎牙、斗鱼和抖音的直播状态与流信息 |
| 录制 | 启停 FFmpeg、分段、状态恢复和异常终止处理 |
| 媒体处理 | 弹幕采集、ASS 字幕、转码与音频提取 |
| 任务系统 | 使用 BullMQ 执行轮询、录制、转码、ASR 和投稿任务 |
| B 站集成 | 登录授权、稿件管理、上传与投稿状态同步 |
| 存储 | 管理 PostgreSQL 业务数据与 S3 兼容对象存储 |
| 可观测性 | Bull Board、结构化日志、健康检查与统一通知 |

主处理链路：

```text
直播状态轮询
  → 创建录制任务
  → FFmpeg 录制和分段
  → 字幕 / ASR / 转码
  → 对象存储
  → B 站投稿
```

## 技术栈

| 层级 | 实现 |
| --- | --- |
| HTTP | Midway.js 3、Koa |
| 语言 | TypeScript |
| 数据库 | PostgreSQL、TypeORM |
| 队列 | Redis、BullMQ |
| 对象存储 | AWS SDK、S3 兼容接口 |
| 媒体 | FFmpeg |
| 浏览器自动化 | Puppeteer |

## 本地开发

### 环境要求

- Node.js 16+
- Docker Engine 与 Docker Compose v2
- FFmpeg；需要执行本地录制或媒体任务时必须安装

启动开发依赖并运行迁移：

```bash
npm ci
docker compose -f docker-compose.dev.yml up -d
npm run migration:run
npm run dev
```

默认入口：

| 服务 | 地址 |
| --- | --- |
| API | http://localhost:7001 |
| Bull Board | http://localhost:7001/ui |
| PostgreSQL | localhost:5432 |
| Redis | localhost:6379 |
| MinIO API | http://localhost:9000 |
| MinIO Console | http://localhost:9001 |
| pgAdmin | http://localhost:5050 |

`docker-compose.dev.yml` 中的凭据仅用于本地开发。暴露到非本机网络前必须替换。

## API

控制器按资源划分：

| 路径 | 范围 |
| --- | --- |
| `/api/streamers` | 主播配置与直播状态 |
| `/api/jobs` | 任务查询、控制与恢复 |
| `/api/bilibili` | B 站认证、上传和投稿 |
| `/api/douyin` | 抖音登录与验证流程 |
| `/api/text` | 文本和字幕处理 |
| `/api/system` | 系统状态与运行配置 |

前端通过 Nginx 代理访问这些接口；生产环境不需要直接暴露 Backend 端口。

## 配置

配置目录按以下优先级解析：

1. `CONFIG_DIR` 指定的目录
2. 项目根目录的 `settings.json`，仅限 local/development 环境
3. `/app/config`
4. 当前工作目录下的 `config/settings.json`
5. `~/.streamer-helper/settings.json`

环境变量优先于文件配置。生产配置应通过 [infra 配置工具](https://github.com/StreamerHelper/infra#配置) 生成，不应将密钥、Cookie 或访问令牌提交到仓库。

## 通知

`NoticeService` 提供统一通知入口。业务可以主动发送通知，日志 Transport 也可以按级别捕获异常日志。

```text
业务事件或日志
  → NoticeService
  → 疲劳抑制
  → 通知通道
```

当前内置 Server 酱通道。日志通知默认疲劳时间为 300 秒，相同事件在疲劳窗口内只发送一次；发送失败会写入独立内部日志，不会中断业务流程。

主要环境变量：

| 变量 | 用途 |
| --- | --- |
| `NOTICE_ENABLED` | 启用统一通知 |
| `NOTICE_LOGGER_ENABLED` | 启用日志捕获 |
| `NOTICE_LOGGER_LEVEL` | 最低通知级别 |
| `NOTICE_LOGGER_FATIGUE_SECONDS` | 默认疲劳时间 |
| `SERVERCHAN_SENDKEY` | Server 酱 SendKey |

新增邮件或短信通道时，实现 `NoticeChannel` 并注册到 `NoticeService`，无需修改日志接入层。

## 命令参考

| 命令 | 作用 |
| --- | --- |
| `npm run dev` | 启动开发服务 |
| `npm run build` | 编译生产代码 |
| `npm run start` | 启动已编译服务 |
| `npm test -- --runInBand` | 串行执行测试 |
| `npm run cov` | 生成测试覆盖率 |
| `npm run lint` | 执行 ESLint |
| `npm run lint:fix` | 自动修复可修复问题 |
| `npm run migration:show` | 查看迁移状态 |
| `npm run migration:run` | 执行开发环境迁移 |
| `npm run migration:run:prod` | 执行生产环境迁移 |
| `npm run migration:revert` | 回滚最近一次迁移 |

提交前的基础检查：

```bash
npm test -- --runInBand
npm run build
npm run lint
```

## 代码结构

| 路径 | 内容 |
| --- | --- |
| `src/controller/` | HTTP 控制器 |
| `src/service/` | 业务服务与外部集成 |
| `src/processor/` | BullMQ 任务处理器 |
| `src/platform/` | 直播平台适配器 |
| `src/entity/` | TypeORM 实体 |
| `src/repository/` | 数据访问 |
| `src/migration/` | 数据库迁移 |
| `src/config/` | 配置加载与校验 |
| `test/` | 自动化测试 |

## 生产部署

生产环境使用 [StreamerHelper Infra](https://github.com/StreamerHelper/infra) 构建和运行。Infra 负责：

- 生成共享配置
- 启动 PostgreSQL、Redis 和 MinIO
- 在应用启动前执行迁移
- 通过 Nginx 暴露 Web、API 与 Bull Board
- 拉取镜像并按版本更新 Backend

不要同时维护一套独立的生产 Compose 配置，以免端口、卷和迁移顺序发生偏差。

## License

[MIT](https://github.com/StreamerHelper/StreamerHelper/blob/main/LICENSE)
