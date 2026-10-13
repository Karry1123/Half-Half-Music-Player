#!/bin/sh
# 容器启动：后台把 yt-dlp 更新到最新版（YouTube / B 站经常改接口，旧版很快就会失效），然后启动服务。
# 更新在后台进行、最多 120 秒，不拖慢启动，也不影响 Render 的健康检查。
# 设 YTDLP_AUTO_UPDATE=0 可关闭。
set -e

if [ "${YTDLP_AUTO_UPDATE:-1}" != "0" ]; then
  (
    before=$(/opt/yt-dlp/bin/yt-dlp --version 2>/dev/null || echo none)
    if timeout 120 /opt/yt-dlp/bin/pip install --no-cache-dir --quiet --upgrade "yt-dlp[default]" >/tmp/yt-dlp-update.log 2>&1; then
      after=$(/opt/yt-dlp/bin/yt-dlp --version 2>/dev/null || echo none)
      [ "$before" != "$after" ] && echo "[entrypoint] yt-dlp 已更新：$before → $after（新版本对之后的请求生效）"
    else
      echo "[entrypoint] yt-dlp 更新失败，继续使用 $before（详见 /tmp/yt-dlp-update.log）"
    fi
  ) &
fi

mkdir -p "${DOWNLOAD_DIR:-/tmp/halfhalf/downloads}" "${CACHE_DIR:-/tmp/halfhalf/cache}"
exec "$@"
