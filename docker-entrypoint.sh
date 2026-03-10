#!/bin/sh
set -e

echo "=== Starting StreamerHelper ==="

# 等待数据库就绪
echo "Waiting for database..."
sleep 5

# 启动应用
echo "Starting application..."
exec node bootstrap.js
