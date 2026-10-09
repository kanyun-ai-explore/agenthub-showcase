import { ownsSession, sessionNotFound } from "@/lib/agenthub/session-binding";
import { crossSiteRequest } from "@/lib/backend/guards";
import { parseTurnTimingReport, TURN_TIMING_MAX_BYTES, turnTimingLogRecord } from "@/lib/agenthub/turn-timing";
import { createTurnTimingLimiter } from "@/lib/agenthub/turn-timing-limit";

/**
 * 情景对话客户端时刻的上报口：页面每个语音回合结束后 POST 一次，这里校验后写**一行**结构化
 * 日志，不写库、不碰平台。字段与上限见 `lib/agenthub/turn-timing.ts`。
 *
 * 日志落点：站点的 stdout，由部署环境的日志采集收走。一行
 * 一个回合，固定前缀后面是 JSON：
 *
 *   [roleplay/turn-timing] {"sessionId":"…","turnId":"…","t0":…,"marks":{…},"audio":{…},
 *                           "releaseToFirstTextMs":…,"releaseToPlayStartMs":…,…}
 *
 * 读法：在站点日志里按前缀 `[roleplay/turn-timing]` 搜。`turnId` 就是平台回合的 turn id，
 * 服务端分段从平台回合事件里同一个 `turnId` 的 `session.turn_audio_*` 事件接上。
 *
 * 跨站挡板照挂（`lib/backend/guards.ts`）：它不花钱，但写日志——别的站点的页面不该能借
 * 用户的浏览器往我们的日志里灌行。请求体先按字节截断再 parse，超过上限整条拒。
 *
 * 限流（`lib/agenthub/turn-timing-limit.ts`，阈值和边界写在那里）：读请求体之前按 IP 数一次，
 * 校验通过之后按会话数一次，超了回 429、不写日志。页面那边报不出去不重试。
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const LOG_PREFIX = "[roleplay/turn-timing]";

/** 进程内存里的计数，进程重启清零、多副本各数各的。 */
const limiter = createTurnTimingLimiter();

function fail(status: number, code: string): Response {
  return Response.json({ error: code }, { status });
}

function rateLimited(now: number): Response {
  const seconds = Math.max(1, Math.ceil(limiter.retryAfterMs(now) / 1000));
  return Response.json({ error: "rate_limited" }, { status: 429, headers: { "Retry-After": String(seconds) } });
}

/** 限流用的来源 IP：`x-forwarded-for` 的第一段，没有就用 `x-real-ip`。客户端可以伪造，边界见限流模块。 */
function clientIp(req: Request): string {
  const forwarded = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim();
  return forwarded || req.headers.get("x-real-ip")?.trim() || "unknown";
}

/** 读请求体，超过 `limit` 字节就停（`null`）——不把一个大包整个读进内存再判。 */
async function readCapped(req: Request, limit: number): Promise<string | null> {
  const declared = Number(req.headers.get("content-length") ?? "");
  if (Number.isFinite(declared) && declared > limit) return null;
  if (!req.body) return "";
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > limit) {
      await reader.cancel().catch(() => undefined);
      return null;
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(bytes);
}

export async function POST(req: Request) {
  if (crossSiteRequest(req)) return fail(403, "cross_origin_not_allowed");
  if (!limiter.admitIp(clientIp(req), Date.now())) return rateLimited(Date.now());
  const raw = await readCapped(req, TURN_TIMING_MAX_BYTES);
  if (raw === null) return fail(413, "too_large");
  const parsed = parseTurnTimingReport(raw, Date.now());
  if (!parsed.ok) return fail(400, parsed.error);
  // 归属：不是这个浏览器建的会话一律 404，在数会话限流和写日志之前（lib/agenthub/session-binding.ts）。
  if (!ownsSession(req, parsed.report.sessionId)) return sessionNotFound();
  if (!limiter.admitSession(parsed.report.sessionId, Date.now())) return rateLimited(Date.now());
  console.log(`${LOG_PREFIX} ${JSON.stringify(turnTimingLogRecord(parsed.report))}`);
  return new Response(null, { status: 204 });
}
