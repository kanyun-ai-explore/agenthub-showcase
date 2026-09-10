#!/bin/bash
# storefront-web 生产启动脚本。
#
# 前提：已经跑过 `pnpm install` 和 `pnpm turbo build`（构建产物在
# apps/storefront-web/.next/）。本脚本只负责启动，不构建。
#
# 有 pm2-runtime 就用它（容器里跑，进程退出即容器退出，日志走 stdout）；
# 没有就直接 `npm run start`——两条路跑的是同一个 `next start`。

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

echo "[storefront-web] Ensuring workspace symlinks..."
bash "${SCRIPT_DIR}/scripts/ensure-workspace-symlinks.sh"

# 默认 8080。这个端口必须与你的部署平台上登记的 httpPort 一致——健康检查和 ingress
# 打的是那个端口，对不上就是「部署起来了但外面打不进」。用 PORT 环境变量覆盖。
echo "[storefront-web] Starting Storefront Web on port ${PORT:-8080}..."

cd "${SCRIPT_DIR}/apps/storefront-web"

if command -v pm2-runtime >/dev/null 2>&1; then
  exec pm2-runtime start npm --name agenthub-showcase-storefront -- run start
fi

echo "[storefront-web] pm2-runtime not found, running next start directly."
exec npm run start
