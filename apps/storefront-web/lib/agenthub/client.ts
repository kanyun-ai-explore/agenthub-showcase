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

export function isAgentHubConfigured(agent: AgentKey = "shopping"): boolean {
  const env = readAgentHubEnv();
  return env !== null && env.agentIds[agent] !== undefined;
}

/** 收窄一个不可信的请求字段；未知值一律当 shopping，不猜。 */
export function parseAgentKey(value: unknown): AgentKey {
  return typeof value === "string" && value in AGENT_ENV ? value : "shopping";
}

/** 某个 agent 没配时对应的环境变量名，用在「未接入」提示里。 */
export function envNameFor(agent: AgentKey): string | undefined {
  return AGENT_ENV[agent];
}

let cached: { env: AgentHubEnv; client: PilotPlatformClient } | null = null;

/** 未配置直接抛；调用方先查 `isAgentHubConfigured()`。绝不静默回落到别的客户端。 */
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
