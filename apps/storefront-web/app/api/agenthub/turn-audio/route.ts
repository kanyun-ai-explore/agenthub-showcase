import { PilotPlatformApiError } from "@kanyun-ai-infra/agenthub";
import { getAgentHubClient, isAgentHubConfigured } from "@/lib/agenthub/client";
import { errorResponse, httpStatusOf } from "@/lib/backend/errors";
import { crossSiteRequest } from "@/lib/backend/guards";

/**
 * 一轮的点评音频：把平台的分段音频读回来交给页面播放。
 *
 * 页面对一轮的音频有两种问法，用一个 `wait` 参数区分：
 * - `wait=1`（默认）：跟读回合刚结束、点评正要播，合成多半还没好——服务端等一小会儿
 *   （`waitForTurnAudio`），拿到 `ready` 就一起返回，页面上「老师说」那几个字后面立刻
 *   能出声。等超时就如实回 `pending`，页面给一个「再听一遍」的按钮。
 * - `wait=0`：只读一次（`getTurnAudio`），页面按按钮时用。
 *
 * `TURN_AUDIO_NOT_FOUND`（404）在这里是**值**不是错误：agent 那一版没声明 `voice.output`
 * 时它就是平台的答案，页面据此显示「这次没有音频点评」而不是报错。原样透出。
 *
 * 段是 OSS 的短时签名 URL，页面直接喂给 `<audio>`（同门户 /w/<slug> 的播放器）；
 * URL 会过期，所以不缓存，每次播都重新读一遍。
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** 等一下合成的上限。跟读的点评是一两句话，等 20 秒还没好就交给页面重试。 */
const WAIT_TIMEOUT_MS = 20_000;

function fail(status: number, code: string, detail?: string): Response {
  return Response.json({ error: code, ...(detail ? { detail } : {}) }, { status });
}

export async function GET(req: Request) {
  if (!isAgentHubConfigured()) {
    return Response.json({ error: "not_configured" }, { status: 501 });
  }
  if (crossSiteRequest(req)) return fail(403, "cross_origin_not_allowed");
  const url = new URL(req.url);
  const sessionId = (url.searchParams.get("sessionId") ?? "").trim();
  const turnId = (url.searchParams.get("turnId") ?? "").trim();
  if (!sessionId || !turnId) {
    return fail(400, "bad_request", "sessionId 和 turnId 都是必填的。");
  }
  const wait = url.searchParams.get("wait") !== "0";

  const { client } = getAgentHubClient();
  try {
    const audio = wait
      ? await client.sessions.waitForTurnAudio(sessionId, turnId, {
          timeoutMs: WAIT_TIMEOUT_MS,
          signal: req.signal,
        })
      : await client.sessions.getTurnAudio(sessionId, turnId, { signal: req.signal });
    return Response.json({
      status: audio.status,
      segments: audio.segments.map((segment) => ({ index: segment.index, url: segment.url })),
      ...(audio.failure ? { failure: audio.failure } : {}),
    });
  } catch (err) {
    if (err instanceof PilotPlatformApiError) {
      // 等超时不是「没有音频」，是「还没好」——按文件头的承诺回 pending，页面的
      // 「还在合成，点这里再试一次」才接得住。（SDK 抛这个错时 status 是 0，
      // 原样塞进 Response 会炸成裸 500，重试按钮永远出不来。）
      if (err.code === "SESSION_TURN_AUDIO_WAIT_TIMEOUT") {
        return Response.json({ status: "pending", segments: [] });
      }
      // TURN_AUDIO_NOT_FOUND（没声明 voice.output / 回合没到终态）也是值，页面按 code 分流。
      return fail(httpStatusOf(err), err.code);
    }
    return errorResponse(err);
  }
}
