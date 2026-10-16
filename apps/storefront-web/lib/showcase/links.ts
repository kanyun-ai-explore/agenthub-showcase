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
/** 仓内某个目录在公开仓库里的地址。 */
export const repoTreeHref = (path: string) => `${REPO}/tree/main/${path}`;
/** 每个 agent 一个目录，都在这下面。 */
export const AGENTS_DIR = "agenthub/agents";

/**
 * 公开仓里没有的路径：文件，或者目录（目录下的路径都算）。名单里的路径只显示文字、不给链接，页面上不出现
 * 打不开的链接（判据只有 `inPublicRepo` 一处）。现在是空的。
 * 链接都用 main 分支路径、不钉 commit：钉 commit 的话以后更新了，链过去的还是旧定义。
 */
const NOT_IN_PUBLIC_REPO: ReadonlySet<string> = new Set<string>([]);

const inPublicRepo = (path: string) => ![...NOT_IN_PUBLIC_REPO].some((gap) => path === gap || path.startsWith(`${gap}/`));

/** 页面上的「源码在哪儿」：公开仓里有的给链接，还没有的给 `undefined`（调用方渲染成纯文字）。 */
export const repoFileLinkHref = (path: string): string | undefined => (inPublicRepo(path) ? repoFileHref(path) : undefined);
/** 同上，目录版。 */
export const repoTreeLinkHref = (path: string): string | undefined => (inPublicRepo(path) ? repoTreeHref(path) : undefined);

/**
 * 能力卡片底下那行「出处」里的仓库路径。只有以 `agenthub/` 开头的才是仓库路径；`a/b/agent.yaml + CLAUDE.md`
 * 这种写法，后面的文件名落在前一个的目录里；「路径 · 说明」里 `·` 后面是说明，不进地址。
 * 其它出处（工具名、env 变量、模型名）给 `null`，调用方原样输出。
 */
export function evidenceParts(text: string): { part: string; label: string; href?: string; note?: string }[] | null {
  if (!text.startsWith("agenthub/")) return null;
  const parts = text.split(" + ");
  const dir = parts[0].slice(0, parts[0].lastIndexOf("/") + 1);
  return parts.map((part) => {
    const [label, ...notes] = part.split(" · ");
    const href = repoFileLinkHref(label.includes("/") ? label : `${dir}${label}`);
    return { part, label, href, note: notes.length > 0 ? notes.join(" · ") : undefined };
  });
}
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
  /** 公开仓里还没有的路径给 `undefined`，渲染成不带链接的一块。 */
  href?: string;
}

/** 页尾「从这里开始」里和 agent 无关的那几条，每页都一样。 */
const DOCS_BEFORE_AGENTS = [
  {
    title: "这个页面的源码",
    sub: "kanyun-ai-explore/agenthub-showcase：一个可以照抄的完整例子",
    href: REPO,
  },
] satisfies DocLink[];
const DOCS_AFTER_AGENTS = [
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
] satisfies DocLink[];

/**
 * 首页、团队群这类不属于哪个 agent 的页面，页尾的「从这里开始」。agent 那一格给 agents 总目录，
 * 不挑某一个 agent 的定义（原来写死导购和商家两个，所有页面的页尾都只给这两个的定义）。
 */
export const DOC_LINKS = [
  ...DOCS_BEFORE_AGENTS,
  {
    title: "所有 Agent 的定义",
    sub: `${AGENTS_DIR}/：每个 Agent 一个目录`,
    href: repoTreeHref(AGENTS_DIR),
  },
  ...DOCS_AFTER_AGENTS,
] satisfies DocLink[];

/** 一个视角在页尾列的 agent。`role` 只给主 agent 以外的那几个用，写进标题。 */
export interface AgentRef {
  dir: string;
  role?: string;
}

/**
 * 一个视角页的「从这里开始」：和 agent 无关的几条中间，插这个视角自己的 agent 的定义（agent.yaml）和目录。
 * 主 agent 是 `agentFile` 所在的目录；一页用到不止一个 agent 的（英语小课），其余的在 `extraAgents` 里按角色列在后面。
 */
export function docLinksFor(surface: { agentFile: string; extraAgents?: AgentRef[] }): DocLink[] {
  const main = surface.agentFile.match(/^agenthub\/agents\/([^/]+)\/agent\.yaml$/)?.[1];
  if (!main) return DOC_LINKS;
  const agents: AgentRef[] = [{ dir: main }, ...(surface.extraAgents ?? [])];
  return [
    ...DOCS_BEFORE_AGENTS,
    ...agents.flatMap(({ dir, role }) => {
      const path = `${AGENTS_DIR}/${dir}`;
      return [
        {
          title: role ? `${role} Agent 的定义` : "这个视角的 Agent 定义",
          sub: `${path}/agent.yaml`,
          href: repoFileLinkHref(`${path}/agent.yaml`),
        },
        {
          title: role ? `${role} Agent 的目录` : "这个 Agent 的目录",
          sub: `${path}/`,
          href: repoTreeLinkHref(path),
        },
      ];
    }),
    ...DOCS_AFTER_AGENTS,
  ];
}

export interface Step {
  title: string;
  body: string;
  code?: string;
  /**
   * 这段代码出自仓库里哪个文件。给了就渲染成代码块的标题（公开仓里还没有这个文件时只显示文件名，
   * 不链过去——见 `CaseStage` 里那段说明）。
   */
  file?: string;
}

/**
 * 全站共用的三步：MCP、Agent 文件、文本会话。视角可以用 `Surface.steps` 整段覆盖它——
 * 走别的链路的视角（如实时语音的 freetalk）照这三步写就成了错引。
 */
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
