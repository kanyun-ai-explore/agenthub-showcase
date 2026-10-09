import {
  agentIdFor,
  envNameFor,
  getAgentHubClient,
  isAgentHubConfigured,
  parseAgentKey,
} from "@/lib/agenthub/client";
import { withSessionBinding } from "@/lib/agenthub/session-binding";
import { errorResponse } from "@/lib/backend/errors";
import { crossSiteRequest } from "@/lib/backend/guards";
import { readVisitor, visitorRequired } from "@/lib/backend/visitor-binding";
import { idTag, logTag } from "@/lib/log-id";

/**
 * 为这个访客预建其它 agent 的会话。
 *
 * 跨 agent 预热的浏览器侧句柄：数学课会话 ready 后，页面对同一访客预建语文课会话，
 * 学生切课那一刻直接复用、不再冷启。句柄存浏览器（站点 2 副本，服务端 .data 是 pod
 * 本地，存不下），本路由只负责把「指定身份的冷启」提前到切课之前发生。
 *
 * 带 `user` 的请求故意走冷启——平台不为指定身份烤预热池槽位，这正是「为这个身份
 * 预热」的正确打开方式：现在付一次冷启动，换来的是学生到门口时沙箱已经就绪。
 *
 * 响应带上这个会话的归属 cookie（`lib/agenthub/session-binding.ts`）：句柄只存 sessionStorage，
 * 切课时 `GET /api/agenthub/session/<id>` 靠同一个浏览器里的这个 cookie 验过。
 *
 * 身份只取访客 cookie `ahv`（`lib/backend/visitor-binding.ts`）：请求 body 里的 `endUserId`
 * 不看——之前谁报别人的 id，就能以别人的身份建会话。没有有效 `ahv` 回 401（页面先调 `/api/visitor` 再预热，
 * 走到这里说明 cookie 存不下；页面把它当预热失败，切课时正常建会话）。响应不回 id，只回代号 `visitorTag`，
 * 页面拿它给句柄做比对。
 */
export async function POST(req: Request) {
  // 跨站挡板（和购物 session 一起挂）：预热会建平台会话、发 `ahs_` cookie，
  // 不该由别的站点的页面替访客触发。判法同 `/api/visitor`。
  if (crossSiteRequest(req)) {
    return Response.json({ error: "cross_origin_not_allowed" }, { status: 403 });
  }
  const body = (await req.json().catch(() => ({}))) as { agent?: unknown };
  const agent = parseAgentKey(body.agent);

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
    const visitorId = readVisitor(req);
    if (!visitorId) return visitorRequired();
    const { client, env } = getAgentHubClient();
    const agentId = agentIdFor(env, agent);
    if (!agentId) throw new Error(`agent「${agent}」没有配置 workload id`);

    const session = await client.sessions.create({
      projectId: env.projectId,
      agentId,
      stage: env.stage,
      user: { id: visitorId },
    });
    console.log(
      `[agenthub/prewarm] ${agent} for ${idTag("visitor", visitorId)} → ${session.sessionId} (${session.status})`,
    );
    return withSessionBinding(
      Response.json({
        agentHubSessionId: session.sessionId,
        status: session.status,
        visitorTag: logTag(visitorId),
      }),
      req,
      session.sessionId,
    );
  } catch (err) {
    return errorResponse(err);
  }
}
