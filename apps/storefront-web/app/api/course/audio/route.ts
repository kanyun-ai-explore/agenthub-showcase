import { PilotPlatformApiError } from "@kanyun-ai-infra/agenthub";
import { getAgentHubClient, isAgentHubConfigured } from "@/lib/agenthub/client";
import { ownsSession, sessionNotFound } from "@/lib/agenthub/session-binding";
import { renderTurn } from "@/lib/agenthub/turn-parts";
import { crossSiteRequest } from "@/lib/backend/guards";
import { lessonFromCards } from "@/lib/course/english-lesson";
import { parseQuestionIndex, readerTextFor } from "@/lib/course/reader-guard";
import { readClip, readerAgentId, ReaderError } from "@/lib/course/reader-service";

/**
 * 单元 3 一道题的读音：经平台的朗读 agent 合成，回一段 WAV。
 *
 * 浏览器只给题的坐标——`session`（学员的 coach 会话）、`turn`（出这一关的那一轮）、`i`（第几道）——
 * **不给要念的文字**（约束 1，约束表见 `lib/course/reader-guard.ts`）。服务端读那一轮
 * （`turns.get`），用页面同一条取题链路（`renderTurn` → `lessonFromCards`）拿到第 i 道，过
 * `readerTextFor`（约束 3、4：只念听音选词和跟读、限长度、限字符集、按题型限词数），再交给
 * `readClip`（约束 2、3、5：reader 会话不出这个进程、按 coach 会话限速、复述必须逐字相等）。
 * 会话结束（terminate）以后那一轮照样读得到（实测），所以刷新页面、本机存下的单元 3 也能取音。
 *
 * 响应头 `X-Reader-Text` 是服务端念的那句（encodeURIComponent 过）：页面拿它和题上显示的原文比，
 * 不一致就不放——草稿和定稿在同一个下标上不是同一道题时，不会放错音。
 *
 * 失败口径：没配 reader 回 501 `reader_not_configured`，页面退到本机语音；
 * 题不能念回 422；限速 429；平台那边没成回 502。错误码之外不带上游原文（同 /api/agenthub/* 的纪律）。
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function fail(status: number, code: string, detail?: string): Response {
  return Response.json({ error: code, ...(detail ? { detail } : {}) }, { status });
}

const STATUS: Record<string, number> = {
  not_configured: 501,
  rate_limited: 429,
  echo_mismatch: 502,
  audio_failed: 502,
  upstream: 502,
};

export async function GET(req: Request) {
  if (crossSiteRequest(req)) return fail(403, "cross_origin_not_allowed");
  if (!isAgentHubConfigured("english-coach") || !readerAgentId()) {
    return fail(501, "reader_not_configured", "站点没有配置朗读 agent，页面会退回本机语音");
  }
  const url = new URL(req.url);
  const sessionId = url.searchParams.get("session") ?? "";
  const turnId = url.searchParams.get("turn") ?? "";
  const index = parseQuestionIndex(url.searchParams.get("i"));
  if (!ID.test(sessionId) || !ID.test(turnId) || index === null) {
    return fail(400, "bad_request", "session、turn 要是 id，i 是题的下标");
  }
  // 归属：不是这个浏览器建的会话一律 404，在调平台之前（lib/agenthub/session-binding.ts）。
  if (!ownsSession(req, sessionId)) return sessionNotFound();

  const { client } = getAgentHubClient();
  let parts: unknown;
  try {
    const turn = await client.sessions.turns.get(sessionId, turnId, { signal: req.signal });
    parts = turn.assistant?.parts;
  } catch (err) {
    if (err instanceof PilotPlatformApiError && err.status === 404) return fail(404, "turn_not_found");
    console.warn(`[course/audio] turns.get failed: ${err instanceof Error ? err.name : "unknown"}`);
    return fail(502, "turn_unavailable");
  }
  const lesson = lessonFromCards(renderTurn(parts as Parameters<typeof renderTurn>[0]).cards);
  const picked = readerTextFor(lesson?.exercises[index]);
  if (!picked.ok) return fail(422, "not_speakable", picked.reason);

  try {
    const { audio, source } = await readClip(sessionId, picked.text);
    return new Response(audio.body, {
      headers: {
        "Content-Type": audio.contentType,
        // 坐标对应的内容不会变（那一轮已经结束），浏览器可以缓存；带学员会话，只给这个浏览器。
        "Cache-Control": "private, max-age=86400",
        "X-Reader-Text": encodeURIComponent(picked.text),
        "X-Reader-Source": source,
      },
    });
  } catch (err) {
    if (err instanceof ReaderError) {
      if (err.code !== "rate_limited") console.warn(`[course/audio] reader ${err.code}: ${err.message}`);
      return fail(STATUS[err.code] ?? 502, `reader_${err.code}`);
    }
    console.warn(`[course/audio] reader failed: ${err instanceof Error ? err.name : "unknown"}`);
    return fail(502, "reader_upstream");
  }
}
