import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // 有意保持最小：这个站点没有需要构建期配置的东西，路由、数据读取和 MCP 端点
  // 都在 app/ 与 lib/ 里。
};

export default nextConfig;
