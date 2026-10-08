import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // 有意保持最小：这个站点没有需要构建期配置的东西，路由、数据读取和 MCP 端点
  // 都在 app/ 与 lib/ 里。唯一的例外是下面的旧路径重定向。

  // 英语小课和情景对话从「在线教育」移到「语言学习」。
  // 旧链接有人存着，308 永久重定向到新路径。不能靠页面兜：findSurface 对不认识的视角 id
  // 回落到场景的第一个视角，旧路径会 200 打开课程顾问。
  async redirects() {
    return [
      { source: "/showcase/education/english-course", destination: "/showcase/language/english-course", permanent: true },
      { source: "/showcase/education/roleplay", destination: "/showcase/language/roleplay", permanent: true },
    ];
  },
};

export default nextConfig;
