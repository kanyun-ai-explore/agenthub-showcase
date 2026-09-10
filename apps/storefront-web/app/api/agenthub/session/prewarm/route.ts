import {
  agentIdFor,
  envNameFor,
  getAgentHubClient,
  isAgentHubConfigured,
  parseAgentKey,
} from "@/lib/agenthub/client";
import { errorResponse } from "@/lib/backend/errors";

/**
 * 为指定访客身份预建其它 agent 的会话。
 *
 * 跨 agent 预热的浏览器侧句柄：数学课会话 ready 后，页面对同一访客预建语文课会话，
 * 学生切课那一刻直接复用、不再冷启。句柄存浏览器（站点 2 副本，服务端 .data 是 pod
 * 本地，存不下），本路由只负责把「指定身份的冷启」提前到切课之前发生。
 *
 * 带 `user` 的请求故意走冷启——平台不为指定身份烤预热池槽位，这正是「为这个身份
 * 预热」的正确打开方式：现在付一次冷启动，换来的是学生到门口时沙箱已经就绪。
 */
export async function POST(req: Request) {
  const body = (await req.json().catch(() => ({}))) as {
    agent?: unknown;
    endUserId?: unknown;
  };
  const agent = parseAgentKey(body.agent);

  if (typeof body.endUserId !== "string" || body.endUserId.trim() === "") {
    return Response.json({ error: "bad_request", detail: "endUserId 必须是非空字符串。" }, { status: 400 });
  }
  const endUserId = body.endUserId;

  if (!isAgentHubConfigured(agent)) {
    return Response.json(
      {
        error: "not_configured",
        detail: `agent「${agent}」未接入：请设置环境变量 ${envNameFor(agent) ?? "对应的 agent id"}。`,
      },
      { status: 501 },
    );
  }
  try {
    const { client, env } = getAgentHubClient();
    const agentId = agentIdFor(env, agent);
    if (!agentId) throw new Error(`agent「${agent}」没有配置 workload id`);

    const session = await client.sessions.create({
      projectId: env.projectId,
      agentId,
      stage: env.stage,
      user: { id: endUserId },
    });
    console.log(
      `[agenthub/prewarm] ${agent} for ${endUserId} → ${session.sessionId} (${session.status})`,
    );
    return Response.json({
      agentHubSessionId: session.sessionId,
      status: session.status,
      userId: endUserId,
    });
  } catch (err) {
    return errorResponse(err);
  }
}
