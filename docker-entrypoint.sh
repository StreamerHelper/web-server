#!/bin/sh
set -e

echo "=== Starting StreamerHelper ==="

wait_for_tcp() {
  local host="$1"
  local port="$2"
  local label="$3"
  local max_wait="${4:-60}"
  local waited=0

  if [ -z "$host" ] || [ -z "$port" ]; then
    return 0
  fi

  echo "Waiting for ${label} at ${host}:${port}..."
  while ! nc -z "$host" "$port" >/dev/null 2>&1; do
    sleep 2
    waited=$((waited + 2))
    if [ "$waited" -ge "$max_wait" ]; then
      echo "Timed out waiting for ${label} at ${host}:${port}" >&2
      exit 1
    fi
  done
}

parse_endpoint_host_port() {
  local endpoint="$1"
  ENDPOINT_HOST=""
  ENDPOINT_PORT=""

  [ -z "$endpoint" ] && return 0

  local scheme="${endpoint%%://*}"
  local rest="${endpoint#*://}"
  local host_port="${rest%%/*}"

  if [ "$host_port" = "$rest" ] && [ "$scheme" = "$endpoint" ]; then
    host_port="$endpoint"
    scheme="http"
  fi

  if printf '%s' "$host_port" | grep -q ':'; then
    ENDPOINT_HOST="${host_port%%:*}"
    ENDPOINT_PORT="${host_port##*:}"
  else
    ENDPOINT_HOST="$host_port"
    if [ "$scheme" = "https" ]; then
      ENDPOINT_PORT="443"
    else
      ENDPOINT_PORT="80"
    fi
  fi
}

wait_for_tcp "${TYPEORM_HOST:-localhost}" "${TYPEORM_PORT:-5432}" "PostgreSQL"
wait_for_tcp "${REDIS_HOST:-localhost}" "${REDIS_PORT:-6379}" "Redis"

parse_endpoint_host_port "${S3_ENDPOINT:-}"
wait_for_tcp "$ENDPOINT_HOST" "$ENDPOINT_PORT" "S3/MinIO"

# 执行数据库迁移
echo "Running database migrations..."
node dist/scripts/run-migrations.js

# 启动应用
echo "Starting application..."
exec node bootstrap.js
