# StreamerHelper Web Server

<p align="center">
<img src="https://s1.ax1x.com/2020/07/22/UbKCpq.png" alt="StreamerHelper" width="100px">
</p>
<h1 align="center">StreamerHelper</h1>

> 全自动直播录制 & B站投稿服务端 — StreamerHelper v2

[![MIT](https://img.shields.io/github/license/ZhangMingZhao1/StreamerHelper?color=red)](https://github.com/ZhangMingZhao1/StreamerHelper/blob/master/LICENSE)
[![pnpm version](https://img.shields.io/pnpm/v/pnpm)](https://github.com/ZhangMingZhao1/StreamerHelper/blob/master/package.json)
[![nodejs version](https://img.shields.io/pnpm/v/node?color=23&label=node&logoColor=white)](https://github.com/ZhangMingZhao1/StreamerHelper/blob/master/package.json)

自动检测主播开播、录制直播流、采集弹幕，并将录像投稿至 B站。支持 **B站直播**、**虎牙**、**斗鱼** 平台。

## 快速开始

```bash
# 克隆
git clone https://github.com/StreamerHelper/web-server.git && cd web-server

# 启动基础设施 (PostgreSQL / Redis / MinIO)
docker-compose up -d

# 安装依赖 & 迁移数据库
pnpm install
pnpm run migration:run

# 启动
pnpm run dev
```

服务地址：`http://localhost:7001`
队列面板：`http://localhost:7001/ui`

### 生产部署

```bash
docker-compose -f docker-compose.full.yml up -d
```

详见 [DEPLOY.md](DEPLOY.md)。

## 基础设施

通过 `docker-compose up -d` 启动：

| 服务 | 端口 | 凭证 |
|------|------|------|
| PostgreSQL | 5432 | postgres / postgres |
| Redis | 6379 | — |
| MinIO | 9000 / 9001 | minioadmin / minioadmin |
| pgAdmin | 5050 | admin@example.com / admin |

## API

### 主播 `/api/streamers`

```
GET    /                获取列表 (?platform=bilibili|huya|douyu)
GET    /stats           统计
GET    /:id             详情
POST   /                添加
POST   /batch           批量添加
PUT    /:id             更新
POST   /:id/delete      删除
POST   /:id/check       检查直播状态
```

### 录制任务 `/api/jobs`

```
GET    /                列表 (?status=&streamerId=&sortBy=&limit=&offset=)
GET    /stats           统计
GET    /browse          按日期分组浏览 (?streamerName=&startDate=&endDate=)
GET    /streamers       有录制记录的主播列表
GET    /:id             详情
GET    /:id/videos      视频列表（含预签名播放链接）
POST   /start           手动启动录制
POST   /:id/stop        停止
POST   /:id/retry       重试
POST   /:id/delete      删除
POST   /:id/videos/merge  合并分片
```

### B站 `/api/bilibili`

```
GET    /auth/status          登录状态
POST   /auth/qrcode          获取登录二维码
POST   /auth/poll             轮询扫码结果
POST   /auth/logout           登出
POST   /upload/video          上传视频
GET    /upload/partitions     分区列表
POST   /submission            创建投稿任务
GET    /submission            投稿列表
GET    /submission/:id        投稿详情
GET    /submission/job/:jobId 某次录制的投稿
```

### 系统 `/api/system`

```
GET    /health     健康检查
GET    /info       系统信息（任务/主播/队列状态）
```

### 任务状态

```
pending → recording → processing → completed
              ↘            ↘
            stopping      failed
              ↓
           cancelled
```

## 配置

配置文件：`src/config/config.default.ts`

关键配置项：

| 配置路径 | 默认值 | 说明 |
|---------|--------|------|
| `koa.port` | 7001 | 服务端口 |
| `livestream.recorder.segmentDuration` | 10 | 分片时长（秒） |
| `livestream.recorder.maxRecordingTime` | 86400 | 最长录制（秒） |
| `livestream.poller.checkInterval` | 60 | 开播检测间隔（秒） |
| `livestream.s3.endpoint` | http://localhost:9000 | S3 端点 |
| `livestream.s3.bucket` | livestream-archive | 存储桶 |
| `submission.defaultTid` | 171 | 默认 B站分区 |

## 许可证

[MIT](LICENSE)
