## ===== 构建阶段 =====
FROM node:18-alpine AS builder

WORKDIR /app

# 只拷贝依赖文件，利用缓存
COPY package*.json ./

# 安装全部依赖（包含 devDependencies），用于构建
RUN npm ci

# 复制源代码并构建 TypeScript
COPY . .
RUN npm run build

# 构建完成后裁剪掉 devDependencies，只保留生产依赖
RUN npm prune --omit=dev


## ===== 生产阶段 =====
FROM node:18-alpine

# 安装 FFmpeg
RUN apk add --no-cache ffmpeg

WORKDIR /app

# 运行环境设为生产
ENV NODE_ENV=production

# 复制构建产物和仅保留生产依赖
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
