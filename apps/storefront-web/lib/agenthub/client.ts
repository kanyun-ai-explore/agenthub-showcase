/**
 * 服务端专用的 `PilotPlatformClient` 包装。绝不从客户端组件 import——它持有的
 * platform-api token 不能进浏览器。
 *
 * agent 用一个 key 寻址（shopping / merchant / course-sales …），每个 key 对应一个
 * 环境变量。原来是写死两个字段，加第三个 agent 就得改三处；现在加一行表就够了。
 */

import { PilotPlatformClient } from "@kanyun-ai-infra/agenthub";

/** 一个 agent key 对应的环境变量名。加 agent = 加一行。 */
const AGENT_ENV: Record<string, string> = {
  shopping: "AGENTHUB_AGENT_ID",
  merchant: "AGENTHUB_MERCHANT_AGENT_ID",
  "course-sales": "AGENTHUB_COURSE_SALES_AGENT_ID",
  "math-tutor": "AGENTHUB_MATH_TUTOR_AGENT_ID",
  "chinese-tutor": "AGENTHUB_CHINESE_TUTOR_AGENT_ID",
  "homework-qa": "AGENTHUB_HOMEWORK_QA_AGENT_ID",
  "learning-analytics": "AGENTHUB_LEARNING_ANALYTICS_AGENT_ID",
  "english-coach": "AGENTHUB_ENGLISH_COACH_AGENT_ID",
  // 英语小课单元 3 的后台出题（edu-english-lesson-gen）。没配就照旧用第二个 coach 会话出题（`lib/course/lesson-agent.ts`）。
  "english-lesson-gen": "AGENTHUB_ENGLISH_LESSON_GEN_AGENT_ID",
  roleplay: "AGENTHUB_ROLEPLAY_AGENT_ID",
  freetalk: "AGENTHUB_FREETALK_AGENT_ID",
};

export type AgentKey = keyof typeof AGENT_ENV | (string & {});

export interface AgentHubEnv {
  token: string;
  projectId: string;
  /** 只收已配置的 key，没配的 agent 会如实报「未接入」而不是回落到别的 agent。 */
  agentIds: Record<string, string>;
  controlPlaneUrl?: string;
  stage: "test" | "production";
}

export function readAgentHubEnv(): AgentHubEnv | null {
  const token = process.env.AGENTHUB_TOKEN;
  const projectId = process.env.AGENTHUB_PROJECT_ID;
  if (!token || !projectId) return null;

  const agentIds: Record<string, string> = {};
  for (const [key, envName] of Object.entries(AGENT_ENV)) {
    const value = process.env[envName];
    if (value) agentIds[key] = value;
  }
  if (Object.keys(agentIds).length === 0) return null;

  return {
    token,
    projectId,
    agentIds,
    controlPlaneUrl: process.env.AGENTHUB_CONTROL_PLANE_URL,
    stage: process.env.AGENTHUB_STAGE === "production" ? "production" : "test",
  };
}

/**
 * 这个 agent 接没接平台。**agent 必填**：原来缺省是 shopping，按会话 id 办事的路由不带参数调它，查的就是
 * 购物的 id——只配了部分 agent、没配 `AGENTHUB_AGENT_ID` 的环境里，所有视角的会话都回 501。
 * 手里有 agent key 的路由（建会话、预热、换票、读音）用它；手里只有会话 id 的用 `isAgentHubReachable`。
 */
export function isAgentHubConfigured(agent: AgentKey): boolean {
  const env = readAgentHubEnv();
  return env !== null && env.agentIds[agent] !== undefined;
}

/**
 * 站点建得出平台客户端（`getAgentHubClient` 不会抛）：token、projectId，加至少一个 agent id。
 *
 * 给手里只有会话 id 的路由用（会话就绪、事件流、回合、回合结果、回合音频、语音回合）。它们按 id 调平台，
 * 不读任何 agent id；会话是哪个 agent 的，建会话时已经定在平台那边了，而建会话和预热两处按请求里的
 * agent key 判过「接没接」。没配的 agent 建不出会话，拿不到归属 cookie，到这些路由只会是 404。
 */
export function isAgentHubReachable(): boolean {
  return readAgentHubEnv() !== null;
}

/**
 * 是不是表里的 key。用 `Object.hasOwn`，不用 `in`：`"constructor" in AGENT_ENV` 为真，原型链上的名字会被当成
 * 一个已知的 agent。
 */
export function isAgentKey(value: unknown): value is string {
  return typeof value === "string" && Object.hasOwn(AGENT_ENV, value);
}

/**
 * 路由读请求里的 `agent` 字段（建会话 `POST /api/agenthub/session`、预热 `…/session/prewarm`、状态
 * `GET /api/agenthub/status`）：
 * - 没带这个字段 → `"shopping"`（页面的缺省）；
 * - 带了、是表里的 key → 原样；
 * - 带了、不是表里的 key（拼错的、已退役的、非字符串、`null`）→ `null`，路由回 400 `unknown_agent`，不调平台。
 *
 * 不能把未知值当 shopping：那样从表里删掉一个 key，等于把它的请求改道去领购物预热池的槽位。退役一个 agent
 * 就是从表里删一行，靠这里拒绝。
 */
export function requestedAgentKey(value: unknown): AgentKey | null {
  if (value === undefined) return "shopping";
  return isAgentKey(value) ? value : null;
}

/** 上面三个路由对未知 agent 的应答。不带任何 cookie。 */
export function unknownAgentResponse(): Response {
  return Response.json(
    { error: "unknown_agent", detail: "没有这个 agent。" },
    { status: 400, headers: { "cache-control": "no-store" } },
  );
}

/** 某个 agent 没配时对应的环境变量名，用在「未接入」提示里。 */
export function envNameFor(agent: AgentKey): string | undefined {
  return AGENT_ENV[agent];
}

let cached: { env: AgentHubEnv; client: PilotPlatformClient } | null = null;

/** 未配置直接抛；调用方先查 `isAgentHubConfigured(agent)` 或 `isAgentHubReachable()`。绝不静默回落到别的客户端。 */
export function getAgentHubClient(): { env: AgentHubEnv; client: PilotPlatformClient } {
  const env = readAgentHubEnv();
  if (!env) {
    throw new Error("AgentHub 未配置：需要 AGENTHUB_TOKEN、AGENTHUB_PROJECT_ID，以及至少一个 agent id。");
  }
  if (cached && cached.env.token === env.token && cached.env.projectId === env.projectId) {
    return cached;
  }
  const client = new PilotPlatformClient({ token: env.token, controlPlaneUrl: env.controlPlaneUrl });
  cached = { env, client };
  return cached;
}

export function agentIdFor(env: AgentHubEnv, agent: AgentKey): string | null {
  return env.agentIds[agent] ?? null;
}

/** `<id 环境变量>` → `<同前缀>_STAGE`：`AGENTHUB_FREETALK_AGENT_ID` → `AGENTHUB_FREETALK_STAGE`。 */
function stageEnvFor(idEnvName: string): string {
  return idEnvName.replace(/_AGENT_ID$/, "_STAGE");
}

/**
 * 某个 agent 的 stage：**先看它自己的覆盖变量**（`AGENTHUB_<X>_STAGE`），只认 `test` /
 * `production` 两个值；没配、或者配了别的值，一律回落到全局的 `AGENTHUB_STAGE`。
 *
 * 为什么要有覆盖：站点只有一个全局 stage（`readAgentHubEnv`），但**槽位是每个 workload 各算各的**。
 * 某个 agent 只有 test 槽时，站点按 production 建它的会话会直接 500 `STAGE_NOT_DEPLOYED`。给这个 agent
 * 单独指 test，就能在 promote 之前用站点试它。
 *
 * `readEnv` 可注入：用例直接喂环境对象，不动进程 env。
 */
export function stageForAgentEnv(
  idEnvName: string | undefined,
  fallback: "test" | "production",
  readEnv: Record<string, string | undefined> = process.env,
): "test" | "production" {
  const raw = idEnvName ? readEnv[stageEnvFor(idEnvName)] : undefined;
  return raw === "test" || raw === "production" ? raw : fallback;
}

/** 按 agent key 的版本；表里没有这个 key（未配置的 agent）时回落全局。 */
export function stageForAgent(env: AgentHubEnv, agent: AgentKey, readEnv?: Record<string, string | undefined>): "test" | "production" {
  return stageForAgentEnv(AGENT_ENV[agent], env.stage, readEnv);
}
