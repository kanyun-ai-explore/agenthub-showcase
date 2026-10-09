import { PilotPlatformApiError } from "@kanyun-ai-infra/agenthub";
import { getAgentHubClient, isAgentHubConfigured } from "@/lib/agenthub/client";
import { ownsSession, sessionNotFound } from "@/lib/agenthub/session-binding";
import { settledTurnBody, waitForTurnWithin } from "@/lib/agenthub/turn-wait";
import { errorResponse, httpStatusOf } from "@/lib/backend/errors";

/**
 * 一轮已派发的回合的结果：等它到终态，交回正文、卡片和工具轨迹（形状同 `/api/agenthub/turn`）。
 *
 * 两处用：语音回合（`/api/agenthub/voice-turn` 派发后只交回转写就返回了，agent 的文字点评从
 * 这里取），和文字回合（`/api/agenthub/turn` 等满 N 秒还没终态时回 pending，余下的从这里取）。
 * 逐字内容走 SSE（`/api/agenthub/stream`），这里是终态的权威——同 `useAgentConversation` 里
 * 「流只管看、请求管终态」的分工。
 *
 * 每次最多挂 `TURN_REQUEST_MAX_MS`（`lib/agenthub/turn-wait.ts`），没到终态就回
 * `{ status: "pending" }`，页面再问一次：一次长挂的请求会被站点前面那一跳反向代理的 60 s
 * 读超时砍掉，短等 + 重问不怕这个。
 * `transcript` 一并带上：voice-turn 那一跳没读到转写时（回合行还不可见），页面从这里补拿。
 *
 * 不挂跨站挡板：只读、不花钱，和 `/api/agenthub/stream` 一样。
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function fail(status: number, code: string, detail?: string): Response {
  return Response.json({ error: code, ...(detail ? { detail } : {}) }, { status });
}

export async function GET(req: Request) {
  const startedAt = Date.now();
  if (!isAgentHubConfigured()) {
    return Response.json({ error: "not_configured" }, { status: 501 });
  }
  const url = new URL(req.url);
  const sessionId = (url.searchParams.get("sessionId") ?? "").trim();
  const turnId = (url.searchParams.get("turnId") ?? "").trim();
  if (!sessionId || !turnId) {
    return fail(400, "bad_request", "sessionId 和 turnId 都是必填的。");
  }
  // 归属：不是这个浏览器建的会话一律 404，在调平台之前（lib/agenthub/session-binding.ts）。
  if (!ownsSession(req, sessionId)) return sessionNotFound();

  const { client } = getAgentHubClient();
  try {
    const settled = await waitForTurnWithin(client, sessionId, turnId, { startedAt, signal: req.signal });
    // 没等到终态不是错：回 pending，页面再问。
    if (!settled) return Response.json({ status: "pending", turnId });
    return Response.json(settledTurnBody(settled, turnId));
  } catch (err) {
    if (err instanceof PilotPlatformApiError) {
      return fail(httpStatusOf(err), err.code);
    }
    return errorResponse(err);
  }
}
