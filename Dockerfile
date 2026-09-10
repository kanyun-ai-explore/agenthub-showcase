# storefront-web 的容器镜像。
#
#   docker build -t agenthub-showcase .
#   docker run --rm -p 8080:8080 \
#     -e AGENTHUB_TOKEN=... -e AGENTHUB_CONTROL_PLANE_URL=... \
#     -e AGENTHUB_PROJECT_ID=... -e AGENTHUB_AGENT_ID=... \
#     agenthub-showcase
#
# 不配任何 AGENTHUB_* 也能起来：页面能看，只是每个视角显示「未接入」。
# 完整的环境变量清单见 README。

FROM node:22.19.0-slim AS build
WORKDIR /app

RUN corepack enable && corepack prepare pnpm@10.17.1 --activate

# 先只拷依赖清单，让 pnpm install 这一层能被缓存
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc turbo.json ./
COPY apps/storefront-web/package.json apps/storefront-web/
RUN pnpm install --frozen-lockfile

COPY . .
RUN pnpm turbo build --filter=@showcase/storefront-web

FROM node:22.19.0-slim
WORKDIR /app
ENV NODE_ENV=production
ENV PORT=8080

RUN corepack enable && corepack prepare pnpm@10.17.1 --activate

COPY --from=build /app /app

# 可变状态（购物车、记忆、待审改动）默认落在这里；挂卷出来才能跨重启保留。
ENV STOREFRONT_DATA_DIR=/app/apps/storefront-web/.data
RUN mkdir -p "$STOREFRONT_DATA_DIR"
VOLUME ["/app/apps/storefront-web/.data"]

EXPOSE 8080
CMD ["bash", "start-storefront-web.sh"]
