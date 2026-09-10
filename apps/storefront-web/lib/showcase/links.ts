/**
 * 页面上「从这里开始」那一段：文档、SDK、源码入口。
 *
 * 演示看完之后，读者的下一个问题一定是「那我怎么开始」，这一段就是答案。
 *
 * AgentHub 控制台与文档站是各家自建的，没有公开地址，所以这里从环境变量读；
 * 不设时全部回落到本仓库，页面上不会出现打不开的链接。部署时可设：
 *
 *   NEXT_PUBLIC_AGENTHUB_PORTAL=https://<你的控制台域名>
 */

export const REPO = "https://github.com/kanyun-ai-explore/agenthub-showcase";

const PORTAL_ENV = process.env.NEXT_PUBLIC_AGENTHUB_PORTAL?.replace(/\/+$/, "");

/** 控制台首页；未配置时回落到源码仓库。 */
export const AGENTHUB_PORTAL = PORTAL_ENV || REPO;
/** 文档站；未配置时回落到源码仓库。 */
export const AGENTHUB_DOCS = PORTAL_ENV ? `${PORTAL_ENV}/docs` : REPO;
/** 给 Agent 读的文档索引；未配置时回落到源码仓库。 */
export const AGENTHUB_LLMS = PORTAL_ENV ? `${PORTAL_ENV}/llms.txt` : REPO;

export interface DocLink {
  title: string;
  sub: string;
  href: string;
}

export const DOC_LINKS: DocLink[] = [
  {
    title: "这个页面的源码",
    sub: "kanyun-ai-explore/agenthub-showcase —— 一个可以照抄的完整例子",
    href: REPO,
  },
  {
    title: "导购 Agent 的定义",
    sub: "agenthub/agents/cma-shopping/agent.yaml",
    href: `${REPO}/blob/main/agenthub/agents/cma-shopping/agent.yaml`,
  },
  {
    title: "商家 Agent 的定义",
    sub: "agenthub/agents/cma-merchant/agent.yaml",
    href: `${REPO}/blob/main/agenthub/agents/cma-merchant/agent.yaml`,
  },
  {
    title: "教育场景的五个 Agent",
    sub: "agenthub/agents/edu-* —— 共用一个 MCP，各自一份系统提示词",
    href: `${REPO}/tree/main/agenthub/agents`,
  },
  {
    title: "前端怎么调 Agent",
    sub: "apps/storefront-web/app/api/agenthub/ —— 建会话、发轮次、SSE 代理",
    href: `${REPO}/tree/main/apps/storefront-web/app/api/agenthub`,
  },
  {
    title: "这个演示站是怎么搭的",
    sub: "docs/showcase-site.md —— 结构、扩展方式、踩过的坑",
    href: `${REPO}/blob/main/docs/showcase-site.md`,
  },
];

export interface Step {
  title: string;
  body: string;
  code?: string;
}

export const GETTING_STARTED: Step[] = [
  {
    title: "把业务能力包成 MCP",
    body: "已有的检索、订单、购物车接口本来就在，包一层 MCP Server 注册到平台，Agent 文件按 id 引用就能调。",
  },
  {
    title: "写一个 Agent 文件",
    body: "模型、工具白名单、系统提示词都是仓库里的文件，走 PR 和流水线，冻结成版本再发布。",
  },
  {
    title: "前端用 SDK 接一条会话",
    body: "建会话、发一轮、等终态，再加一条 SSE 做逐字渲染。这个页面本身就是这段代码。",
    code: `import { PilotPlatformClient } from "@kanyun-ai-infra/agenthub";

const ah = new PilotPlatformClient({ token: process.env.AGENTHUB_TOKEN });
const s = await ah.sessions.create({ projectId, agentId, stage: "test" });
await ah.sessions.wait(s.sessionId);

const t = await ah.sessions.sendTurn(s.sessionId, { text: "帮我配一套露营装备" });
const { turn } = await ah.sessions.waitForTurn(s.sessionId, t.turnId);`,
  },
];
