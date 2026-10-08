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
export const AGENTHUB_DOCS = PORTAL_ENV ? `${PORTAL_ENV}/v1/docs` : REPO;
/** 给 Agent 读的文档索引；未配置时回落到源码仓库。 */
export const AGENTHUB_LLMS = PORTAL_ENV ? `${PORTAL_ENV}/llms.txt` : REPO;
/** 仓内某个文件在公开仓库里的地址。 */
export const repoFileHref = (path: string) => `${REPO}/blob/main/${path}`;
/**
 * 一条会话在控制台里的落点：Sessions 主视图（带 inspector），不是 /p/<pid>/s/<sid> 对话工作台。
 * 没配控制台地址时返回 null，页面就不显示这个入口。
 */
export const portalSessionHref = (projectId: string, sessionId: string): string | null =>
  PORTAL_ENV
    ? `${PORTAL_ENV}/${encodeURIComponent(projectId)}/sessions?session=${encodeURIComponent(sessionId)}`
    : null;

export interface DocLink {
  title: string;
  sub: string;
  href: string;
}

export const DOC_LINKS: DocLink[] = [
  {
    title: "这个页面的源码",
    sub: "kanyun-ai-explore/agenthub-showcase：一个可以照抄的完整例子",
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
    sub: "agenthub/agents/edu-*：共用一个 MCP，各自一份系统提示词",
    href: `${REPO}/tree/main/agenthub/agents`,
  },
  {
    title: "前端如何调用 Agent",
    sub: "apps/storefront-web/app/api/agenthub/：建会话、发轮次、SSE 代理",
    href: `${REPO}/tree/main/apps/storefront-web/app/api/agenthub`,
  },
  {
    title: "这个演示站的搭建方式",
    sub: "docs/showcase-site.md：结构、扩展方式、遇到过的问题",
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
    title: "把业务能力封装成 MCP",
    body: "检索、订单、购物车接口本来就有，外面包一层 MCP Server 注册到平台，Agent 文件按 ID 引用就能调用。",
  },
  {
    title: "写一个 Agent 文件",
    body: "模型、工具白名单和系统提示词都是仓库里的文件，经过 PR 和流水线，冻结成版本后再发布。",
  },
  {
    title: "前端用 SDK 接入会话",
    body: "建会话、发一轮对话、等终态，再加一条 SSE 做逐字渲染。这个页面用的就是这段代码。",
    code: `import { PilotPlatformClient } from "@kanyun-ai-infra/agenthub";

const ah = new PilotPlatformClient({ token: process.env.AGENTHUB_TOKEN });
const s = await ah.sessions.create({ projectId, agentId, stage: "test" });
await ah.sessions.wait(s.sessionId);

const t = await ah.sessions.sendTurn(s.sessionId, { text: "帮我配一套露营装备" });
const { turn } = await ah.sessions.waitForTurn(s.sessionId, t.turnId);`,
  },
];
