# 录制完成后自动投稿设计文档

## 1. 概述

实现录制完成后自动触发 B站投稿功能。

## 2. 整体流程

```
录制结束 (emitEnd)
    ↓
检查 cancelled? → 是 → 跳过
    ↓ 否
检查已上传分片数量 > 0 ?
    ↓ 是
检查 autoUpload? (默认 true)
    ↓ 是
创建投稿记录 (BilibiliSubmission)
    ↓
派发投稿任务到 bilibili-submission 队列
    ↓
┌─────────────────────────────────────┐
│         投稿处理流程                  │
│  1. 获取最新 streamer 信息           │
│  2. 下载合并分片                     │
│  3. 上传到 B站                       │
│  4. 提交稿件                         │
└─────────────────────────────────────┘
    ↓                         ↓
  成功                      失败
    ↓                         ↓
  COMPLETED                FAILED
```

## 3. 投稿触发条件

| 录制结果 | 触发投稿条件 |
|----------|-------------|
| completed | ✅ 始终触发（有分片） |
| failed / heartbeat_timeout / ffmpeg_error | ✅ 有分片时触发 |
| max_duration | ✅ 有分片时触发 |
| cancelled | ❌ 不触发 |

## 4. 数据结构

### Streamer.uploadSettings

```typescript
uploadSettings: {
  autoUpload?: boolean;   // 是否自动投稿（默认 true）
  title?: string;         // 投稿标题
  description?: string;   // 投稿简介
  tags?: string[];        // 标签
  tid?: number;           // 分区ID
}
```

### BilibiliSubmissionEntity

已移除重试相关字段（`retryCount`、`maxRetries`），投稿失败直接标记为 `FAILED`。

## 5. 接口

### POST /api/streamers - 添加主播

```json
{
  "streamerId": "12345",
  "name": "主播名",
  "platform": "bilibili",
  "roomId": "21752686",
  "uploadSettings": {
    "autoUpload": true,
    "title": "投稿标题",
    "description": "简介",
    "tags": ["标签1", "标签2"],
    "tid": 171
  }
}
```

### PUT /api/streamers/:id - 更新主播

```json
{
  "uploadSettings": {
    "autoUpload": false,
    "title": "新标题"
  }
}
```
