import { isTerminalTurnStatus, PilotPlatformApiError } from "@kanyun-ai-infra/agenthub";
import { getAgentHubClient, isAgentHubConfigured } from "@/lib/agenthub/client";
import { ownsSession, sessionNotFound } from "@/lib/agenthub/session-binding";
import { errorResponse, httpStatusOf } from "@/lib/backend/errors";
import { crossSiteRequest } from "@/lib/backend/guards";

/**
 * 语音回合：跟读卡录完的一段音从这里上传并派发，**派发后先把转写交回页面**。
 *
 * 浏览器侧不能自己上传（token 在服务端，且语音回合必须由**站点自己的 token** 发出），
 * 所以录音以 multipart 交到这里，由这一跳持有凭据去做 SDK 的 `sessions.sendVoiceTurn`
 * ——它自己就是两步：`files.upload`（要 `files:upload` scope）再带空文本派发一轮
 * （要 `runs:create`）。两步不是事务：派发被拒时上传的文件已经落在平台的附件存储里，
 * 这里如实把它报上去，不重试（重试会上传第二份）。
 *
 * 为什么不再在这里 `waitForTurn`（跟读的 W3）：孩子读完一句，要的是
 * 立刻看到逐词比对，而比对只需要转写。平台在**派发前**同步转写，转写文本就是这一轮的
 * `user.text`，派发一返回它就在回合上了——这里只读一次回合行（`turns.get`）把它取出来，
 * 不等 agent 写点评。点评（回复文字）由页面另走 `GET /api/agenthub/turn-result` 取，
 * 不挡孩子点「继续」。原来要等整轮（上限 120 s）才返回，孩子盯着「老师正在听…」干等。
 *
 * 回合行在派发返回后不一定马上能读到（平台的投影有个可见性窗口，SDK 的 `waitForTurn`
 * 对头 30 s 的 404 也是重试的），所以这里按 `TURN_NOT_FOUND` 短轮询；读到了但转写还空、
 * 或者等满 `TRANSCRIPT_WAIT_MS` 还没读到，就回 `transcript: null`——页面从 turn-result
 * 的 `transcript` 字段里补拿，不当成「没听清」。
 *
 * 失败口径：平台语音路径的拒法带着稳定的错误码（VOICE_INPUT_TOO_LONG / VOICE_
 * TRANSCRIPT_EMPTY / VOICE_RATE_LIMITED / VOICE_MODEL_NOT_AUTHORIZED …），原样回给页面，
 * 由页面决定对孩子说什么——这一层不翻译成人话，免得两处口径漂移。
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** 单段上限 2 MB（平台同一个数）。客户端先挡了一道，这里再挡，谁都不依赖谁。 */
const MAX_AUDIO_BYTES = 2 * 1024 * 1024;
/** 读回合行拿转写的上限。转写在派发前就做完了，这里等的只是回合行可见。 */
const TRANSCRIPT_WAIT_MS = 8_000;
const TRANSCRIPT_POLL_MS = 250;

function fail(status: number, code: string, detail?: string): Response {
  return Response.json({ error: code, ...(detail ? { detail } : {}) }, { status });
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal.addEventListener("abort", () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

/**
 * 读这一轮的 `user.text`。`null` = 这一跳没拿到（回合行还不可见，或转写还没写上）——
 * 和「转写是空串」不是一回事，页面据此决定去 turn-result 补拿还是说「没听清」。
 */
async function readTranscript(
  client: ReturnType<typeof getAgentHubClient>["client"],
  sessionId: string,
  turnId: string,
  signal: AbortSignal,
): Promise<string | null> {
  const deadline = Date.now() + TRANSCRIPT_WAIT_MS;
  while (!signal.aborted) {
    try {
      const turn = await client.sessions.turns.get(sessionId, turnId, { signal });
      const text = turn.user?.text ?? "";
      if (text) return text;
      // 回合都结束了转写还是空的：那就是真的空（平台对空转写本该 422 拒掉，这里兜底）。
      if (isTerminalTurnStatus(turn.status)) return "";
    } catch (err) {
      if (!(err instanceof PilotPlatformApiError && err.code === "TURN_NOT_FOUND")) throw err;
    }
    if (Date.now() >= deadline) return null;
    await sleep(TRANSCRIPT_POLL_MS, signal);
  }
  return null;
}

export async function POST(req: Request) {
  if (!isAgentHubConfigured()) {
    return Response.json({ error: "not_configured" }, { status: 501 });
  }
  // 花的是平台的钱（回合 + 转写），跨站挡板和 /api/course/audio 同一条（见 lib/backend/guards.ts）。
  if (crossSiteRequest(req)) return fail(403, "cross_origin_not_allowed");

  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return fail(400, "bad_request", "请求不是合法的 multipart 表单。");
  }

  const sessionId = String(form.get("sessionId") ?? "").trim();
  if (!sessionId) return fail(400, "bad_request", "缺少 sessionId。");
  // 归属：不是这个浏览器建的会话一律 404，在调平台之前（lib/agenthub/session-binding.ts）。
  if (!ownsSession(req, sessionId)) return sessionNotFound();

  const audio = form.get("audio");
  if (!(audio instanceof File)) return fail(400, "bad_request", "缺少录音（audio 字段）。");
  if (audio.size === 0) return fail(400, "bad_request", "录音是空的。");
  if (audio.size > MAX_AUDIO_BYTES) {
    return fail(413, "VOICE_INPUT_TOO_LONG", `录音超过 ${MAX_AUDIO_BYTES} 字节上限。`);
  }

  const { client, env } = getAgentHubClient();
  const startedAt = Date.now();
  try {
    const dispatched = await client.sessions.sendVoiceTurn(
      sessionId,
      {
        // 语音路径要求附件落在**会话自己项目**的前缀下，所以这里必须是站点的 projectId。
        projectId: env.projectId,
        audio,
        // 扩展名是平台的语音门要读的字段（.webm/.m4a/…），由录音端命名后原样带过来。
        filename: audio.name,
        ...(audio.type ? { contentType: audio.type } : {}),
      },
      { signal: req.signal },
    );
    if (dispatched.kind === "revival_in_progress") {
      // 会话被回收过，平台已在服务端重放这轮的输入，不能重发（同 /api/agenthub/turn）。
      return Response.json({ status: "revival_in_progress" });
    }
    const dispatchedMs = Date.now() - startedAt;
    const transcript = await readTranscript(client, sessionId, dispatched.turnId, req.signal);
    return Response.json({
      status: "dispatched",
      turnId: dispatched.turnId,
      // 转写就是这一轮的 user.text；null = 这一跳没读到，页面去 turn-result 补拿。
      transcript,
      audioBytes: audio.size,
      // 服务端这一跳的两段耗时：上传 + 派发（含平台同步转写）、再到读出转写。
      timing: { dispatchedMs, transcriptMs: Date.now() - startedAt },
    });
  } catch (err) {
    // 语音路径的拒法带稳定 code（见文件头），原样透出；其余走站点统一的错误口径。
    // **不带 err.message**：平台的文案是写给开发者的英文，页面会把它端给孩子看。
    // code 已经足够分流（页面的中文映射表在 lib/agenthub/voice-errors.ts）。
    if (err instanceof PilotPlatformApiError) {
      // 状态码收窄：SDK 的客户端侧错误带的是 0，塞进 Response 会抛 RangeError 变成裸 500。
      return fail(httpStatusOf(err), err.code);
    }
    return errorResponse(err);
  }
}
