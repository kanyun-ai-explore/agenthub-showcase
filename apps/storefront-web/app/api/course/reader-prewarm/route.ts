import { ownsSession, sessionNotFound } from "@/lib/agenthub/session-binding";
import { crossSiteRequest } from "@/lib/backend/guards";
import { readVisitor, visitorRequired } from "@/lib/backend/visitor-binding";
import { prewarmReader } from "@/lib/course/reader-service";

/**
 * 单元 3 的 reader 会话预建。页面在一关开始出题的那一刻调一次，只报出题的那个 coach 会话；
 * 站点趁出题回合跑的这几十秒把这个学员的朗读会话建好（`prewarmReader`），第一句读音要合成时不用再等建会话。
 *
 * 守卫和别的花平台钱的路由同一套，按这个顺序：
 *   1. 跨站挡板（`crossSiteRequest`）→ 403。这是写操作：会在平台上建一个会话。
 *   2. 访客身份（只认 `ahv` cookie）→ 401 `visitor_required`。
 *   3. 请求体只有一个会话 id，不是 id → 400。
 *   4. 会话归属（`ownsSession`，coach 会话的 `ahs_<sid>`）→ 404 `session_not_found`，在碰平台之前。
 *
 * 过了守卫就回 202，**不等建会话**：建会话正常 2 s 上下，平台慢的时候 `sessions.wait` 会挂到 60 s，正好撞上
 * 站点前面那一跳反向代理的 60 s 读超时，等它只会让一个页面不关心结果的请求变成 504。结果页面也用不上——
 * 建成了第一句就快，没建成（没配朗读 agent、平台报错）取音时照旧懒建。`prewarmReader` 自己接住所有失败，
 * 这里不会留下没人处理的 rejection；建成与否看站点日志的 `[course/reader] prewarm` 行。
 *
 * 反复调用刷不出会话：同一个 coach 会话已经有朗读会话就什么都不做，正在建就并到那一次上
 * （`reader-service.ts` 的 `sessionFor`）。预建不发朗读回合，不占那边的限速。响应不带朗读会话的 id，不发 cookie。
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** 请求体上限：只有一个 uuid。 */
const MAX_BODY_BYTES = 512;

function fail(status: number, code: string): Response {
  return Response.json({ error: code }, { status, headers: { "cache-control": "no-store" } });
}

export async function POST(req: Request) {
  if (crossSiteRequest(req)) return fail(403, "cross_origin_not_allowed");
  if (!readVisitor(req)) return visitorRequired();

  let sessionId = "";
  try {
    const raw = await req.text();
    if (raw.length > MAX_BODY_BYTES) return fail(413, "bad_request");
    const parsed: unknown = raw ? JSON.parse(raw) : null;
    if (parsed && typeof parsed === "object" && typeof (parsed as { sessionId?: unknown }).sessionId === "string") {
      sessionId = (parsed as { sessionId: string }).sessionId;
    }
  } catch {
    return fail(400, "bad_request");
  }
  if (!ID.test(sessionId)) return fail(400, "bad_request");
  // 归属：不是这个浏览器建的会话一律 404（和「不存在」同形），在碰平台之前。
  if (!ownsSession(req, sessionId)) return sessionNotFound();

  void prewarmReader(sessionId);
  return new Response(null, { status: 202, headers: { "cache-control": "no-store" } });
}
