# Half&Half 后端：music-service（搜索 / 解析 / 下载）+ WebRTC 信令（/ws）+ ICE 配置（/ice.json）
# 适用于 Render（Docker 运行时）以及任何能跑容器的平台。构建上下文是仓库根目录。
#
#   docker build -t halfhalf-music .
#   docker run -p 10000:10000 -e API_TOKEN=... -e CORS_ORIGINS=https://you.github.io halfhalf-music
FROM node:22-bookworm-slim

# python3 + ffmpeg：yt-dlp 运行与转码 / 转封装；tini：正确转发信号、回收 yt-dlp 子进程
RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 python3-venv ffmpeg ca-certificates tini \
 && rm -rf /var/lib/apt/lists/*

# yt-dlp 装在独立的虚拟环境里（Debian 禁止往系统 Python 里 pip install）。
# [default] 附带 brotli / certifi / websockets 等推荐依赖；构建时总是取最新版，容器启动时还会再检查更新
RUN python3 -m venv /opt/yt-dlp \
 && /opt/yt-dlp/bin/pip install --no-cache-dir --upgrade pip "yt-dlp[default]" \
 && chown -R node:node /opt/yt-dlp

WORKDIR /app

# 先只拷依赖清单，源码改动时可以复用依赖层缓存
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts --no-audit --no-fund
COPY music-service/package.json music-service/package-lock.json ./music-service/
RUN npm ci --omit=dev --prefix music-service --no-audit --no-fund

# server/：信令与 ICE 配置；music-service/：音乐服务
COPY server ./server
COPY music-service/src ./music-service/src
COPY music-service/public ./music-service/public
COPY deploy/docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN chmod +x /usr/local/bin/docker-entrypoint.sh

ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=10000 \
    YTDLP_PATH=/opt/yt-dlp/bin/yt-dlp \
    YTDLP_JS_RUNTIMES=node \
    FFMPEG_PATH=ffmpeg \
    DOWNLOAD_DIR=/tmp/halfhalf/downloads \
    CACHE_DIR=/tmp/halfhalf/cache \
    ENABLE_SIGNALING=1

# 不以 root 运行；只需要写 /tmp（下载、缓存）和 /opt/yt-dlp（启动时自动更新）
USER node
EXPOSE 10000

ENTRYPOINT ["/usr/bin/tini", "--", "docker-entrypoint.sh"]
CMD ["node", "music-service/src/server.js"]
