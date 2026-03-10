# 构建阶段
FROM node:18-alpine AS builder

WORKDIR /app

# 安装依赖
COPY package*.json ./
RUN npm ci --only=production

# 复制源代码
COPY . .

# 构建 TypeScript
RUN npm run build

# 生产阶段
FROM node:18-alpine

# 安装 FFmpeg
RUN apk add --no-cache ffmpeg

WORKDIR /app

# 复制构建产物和依赖
COPY --from=builder /app/package*.json ./
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/dist ./dist

# 创建日志、临时和配置目录
RUN mkdir -p logs temp config

# 配置目录（可通过 volume 挂载）
VOLUME ["/app/config"]

# 暴露端口
EXPOSE 7001

# 健康检查
HEALTHCHECK --interval=30s --timeout=10s --start-period=40s --retries=3 \
  CMD node -e "require('http').get('http://localhost:7001/health', (r) => {process.exit(r.statusCode === 200 ? 0 : 1)})"

# 启动应用
CMD ["node", "bootstrap.js"]
