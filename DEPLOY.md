# 部署指南

## 快速启动

### 1. 仅启动基础设施（开发环境）

```bash
docker-compose up -d
```

启动的服务：
- **PostgreSQL**: `localhost:5432` (用户/密码: `postgres/postgres`)
- **Redis**: `localhost:6379`
- **MinIO**:
  - API: `http://localhost:9000`
  - Console: `http://localhost:9001` (minioadmin/minioadmin)
- **pgAdmin**: `http://localhost:5050` (admin@example.com/admin)

然后本地启动应用：
```bash
npm install
npm run dev
```

应用启动后访问：
- **API**: http://localhost:7001
- **Bull Board**: http://localhost:7001/ui

### 2. 启动完整服务（生产环境）

```bash
docker-compose -f docker-compose.full.yml up -d
```

包含基础设施 + 应用服务。

### 3. 停止服务

```bash
docker-compose down
# 或
docker-compose -f docker-compose.full.yml down
```

### 4. 查看日志

```bash
# 查看所有服务日志
docker-compose logs -f

# 查看特定服务日志
docker-compose logs -f app
docker-compose logs -f postgres
docker-compose logs -f redis
```

### 5. 清理数据（谨慎使用）

```bash
docker-compose down -v
```

## 服务说明

| 服务 | 端口 | 用途 |
|------|------|------|
| PostgreSQL | 5432 | 数据库 |
| Redis | 6379 | 缓存/队列 |
| MinIO | 9000, 9001 | 对象存储 |
| pgAdmin | 5050 | 数据库管理 |
| App | 7001 | 应用服务 (含 Bull Board) |

## Bull Board 队列管理

Bull Board 已集成到应用中，无需额外服务。

访问地址: http://localhost:7001/ui

可管理的队列：
- `recording` - 录制任务
- `transcode` - 转码任务
- `analyze` - 分析任务
- `cleanup` - 清理任务

## MinIO 使用

访问 Console: http://localhost:9001

- Access Key: `minioadmin`
- Secret Key: `minioadmin`
- 默认桶: `streamerhelper-archive`

## pgAdmin 使用

访问: http://localhost:5050

- Email: `admin@example.com`
- Password: `admin`

添加服务器连接：
- Host: `postgres` (Docker) 或 `localhost` (本地)
- Port: `5432`
- Username: `postgres`
- Password: `postgres`
- Database: `streamerhelper`

## 数据持久化

所有数据存储在 Docker volumes 中：
- `postgres_data` - PostgreSQL 数据
- `redis_data` - Redis 数据
- `minio_data` - MinIO 对象存储
- `pgadmin_data` - pgAdmin 配置
