#!/bin/sh
set -e

echo "=== Starting StreamerHelper ==="

# 等待数据库就绪（compose 已有 healthcheck，这里做一次简单延迟）
echo "Waiting for database..."
sleep 5

# 执行数据库迁移
echo "Running database migrations..."
node dist/scripts/run-migrations.js

# 启动应用
echo "Starting application..."
exec node bootstrap.js
