import { PilotPlatformApiError } from "@kanyun-ai-infra/agenthub";
import { getAgentHubClient, isAgentHubConfigured } from "@/lib/agenthub/client";
import { ownsSession, sessionNotFound } from "@/lib/agenthub/session-binding";
import { resolveVisitor, visitorRequired } from "@/lib/backend/visitor-binding";
import { httpStatusOf } from "@/lib/backend/errors";
import { crossSiteRequest } from "@/lib/backend/guards";
import { idTag } from "@/lib/log-id";

/**
 * 实时语音的换票口：浏览器拿一张一次性的票去和平台的实时语音网关建 WebSocket。
 * 平台 token 只在服务端，所以票由站点换（token 要有 `runs:create`）。
 *
 * 调平台之前先过四道守卫：没配置 501、跨站 403、没有访客身份 401、不是这个浏览器建的会话 404。
 * 票、cookie 值和平台错误的 message 都不进日志；平台的错误码原样回给页面，
 * 由页面决定回落还是重试（`lib/agenthub/realtime-errors.ts`）。
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_BODY_BYTES = 512;

function fail(status: number, code: string): Response {
  return Response.json({ error: code }, { status, headers: { "cache-control": "no-store" } });
}

export async function POST(req: Request) {
  if (!isAgentHubConfigured("freetalk")) return fail(501, "not_configured");
  if (crossSiteRequest(req)) return fail(403, "cross_origin_not_allowed");

  const visitorId = resolveVisitor(req, undefined);
  if (!visitorId) return visitorRequired();

  let sessionId = "";
  try {
    const raw = await req.text();
    if (raw.length > MAX_BODY_BYTES) return fail(413, "bad_request");
    const parsed: unknown = raw ? JSON.parse(raw) : null;
    if (parsed && typeof parsed === "object" && typeof (parsed as { sessionId?: unknown }).sessionId === "string") {
      sessionId = (parsed as { sessionId: string }).sessionId.trim();
    }
  } catch {
    return fail(400, "bad_request");
  }
  if (!sessionId) return fail(400, "bad_request");
  if (!ownsSession(req, sessionId)) return sessionNotFound();

  try {
    const { client } = getAgentHubClient();
    const ticket = await client.sessions.createVoiceTicket(sessionId, { signal: req.signal });
    console.log(
      `[freetalk/voice-ticket] issued ${idTag("visitor", visitorId)} ${idTag("session", sessionId)} expiresAt=${ticket.expiresAt}`,
    );
    return Response.json(
      { ticket: ticket.ticket, gatewayUrl: ticket.gatewayUrl, expiresAt: ticket.expiresAt },
      { status: 200, headers: { "cache-control": "no-store" } },
    );
  } catch (err) {
    if (err instanceof PilotPlatformApiError) {
      console.warn(
        `[freetalk/voice-ticket] platform refused ${idTag("visitor", visitorId)} ${idTag("session", sessionId)} ${err.code ?? "?"} http=${httpStatusOf(err)}`,
      );
      return fail(httpStatusOf(err), err.code);
    }
    console.warn(
      `[freetalk/voice-ticket] failed ${idTag("visitor", visitorId)} ${idTag("session", sessionId)}`,
    );
    return fail(502, "voice_ticket_failed");
  }
}
