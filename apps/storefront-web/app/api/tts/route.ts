/**
 * 英语小课的读音：把一句话交给模型网关的语音合成，返回音频字节。
 *
 * 为什么要站点自建而不是用平台的语音回合：听音题要的是**稳定的
 * 一个词**，回合制语音是为跟读/对话设计的，为一道听音题多发一次回合不值当；自建还能缓存
 * ——同一个词在一节课里会被点很多次。
 *
 * 链路：浏览器 `/api/tts?text=coffee` → 这里 → `{MODELGATE_TTS_BASE_URL}/v1/audio/speech`
 * （OpenAI 兼容形状）→ 音频按 blob 回给页面。
 *
 * **key 只从站点环境变量读，值不进代码、不进日志、不进响应**：`MODELGATE_API_KEY` 是
 * 部署时配的 secret，模型网关地址 `MODELGATE_TTS_BASE_URL` 同样从环境变量读、代码里没有默认值。
 * 两者任一没配时这里回 503 + `tts_not_configured`（fail-closed，不假装能播），
 * 页面收到就退到浏览器自带的 speechSynthesis 并把这点标在题卡角上——听音题在 key 配好之前
 * 也能把链路走通，而不是整类题变成死链接。
 *
 * 默认模型 `qwen3-tts-flash` + voice `Cherry` 是**实测过的**，不是猜的：拿站点这把 key
 * 直调模型网关的 `/v1/audio/speech`，
 * `response_format` 传 mp3 / wav / 不传三种都回 200 + `audio/x-wav`（文件头 `RIFF....WAVE`，
 * PCM 24 kHz 单声道 16-bit）——**qwen 不出 mp3**，所以这里请求 wav、回给浏览器的 content-type
 * 原样用上游给的。WAV 头里的 RIFF / data 长度是流式占位值（0x7fffffbf），浏览器按实际
 * 字节读：Chrome 154 走页面同一条路（blob → `new Audio().play()`）canplay / playing / ended
 * 齐全；WebKit 也能播完，只是刚加载时 duration 报成占位长度。页面不读 duration，播不出来
 * 也会退到本机语音。之前用的是 `azure-openai-gpt-4o-mini-tts` + `alloy` + mp3。缓存键带
 * model 和 voice，换模型不会命中旧音频。
 * `MODELGATE_TTS_MODEL` / `MODELGATE_TTS_VOICE` 仍可覆盖，换之前先照上面那条口径验一遍；
 * 出问题时看日志（原文）与响应里的 `error.detail`（只剩状态码 + 上游 error.code），见
 * `describeUpstreamError`。
 */

import { crossSiteRequest } from "@/lib/backend/guards";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** 实测：模型网关上这个模型 + Cherry 合成成功，回 audio/x-wav。 */
const DEFAULT_MODEL = "qwen3-tts-flash";
const DEFAULT_VOICE = "Cherry";
/** qwen3-tts-flash 只出 WAV（传 mp3 也回 WAV），请求就照实写 wav。 */
const RESPONSE_FORMAT = "wav";
/** 上游没给 content-type 时的兜底，与 RESPONSE_FORMAT 对应。 */
const FALLBACK_CONTENT_TYPE = "audio/wav";
/** 一个词/一句话的量级。超了直接拒，不拿去烧配额。 */
const MAX_TEXT_LENGTH = 200;
/** 上游超时：一句话的合成等 20s 已经是故障，不能让请求一直挂着。 */
const UPSTREAM_TIMEOUT_MS = 20_000;
/**
 * 进程内缓存：同一个词一节课里会被点很多次。多副本各存一份，这不是正确性问题。
 * WAV 是未压缩的（一个词约 60 KB，满 200 字符约 1 MB），64 条的上限照样够用。
 */
const CACHE_LIMIT = 64;
// 存 ArrayBuffer 而不是 Uint8Array：`Response` 的 BodyInit 只认 ArrayBuffer 那一支，
// Uint8Array 的默认类型参数是 ArrayBufferLike，塞不进去。
const cache = new Map<string, { body: ArrayBuffer; contentType: string }>();

/** 站点环境变量读出来总是 string | undefined，空串当没配（部署平台上清空过的变量就长这样）。 */
function readEnv(name: string): string | undefined {
  const value = process.env[name]?.trim();
  return value ? value : undefined;
}

function cacheKey(model: string, voice: string, text: string): string {
  return `${model}\u0000${voice}\u0000${text}`;
}

function remember(key: string, value: { body: ArrayBuffer; contentType: string }): void {
  if (cache.size >= CACHE_LIMIT) {
    const oldest = cache.keys().next();
    if (!oldest.done) cache.delete(oldest.value);
  }
  cache.set(key, value);
}

function fail(status: number, code: string, detail?: string): Response {
  return Response.json({ error: code, ...(detail ? { detail } : {}) }, { status });
}

/** 写日志前把 key 抹掉：日志会被人看、会被转贴，值不进日志是同一批纪律。 */
function masked(text: string, secret: string): string {
  return secret && text.includes(secret) ? text.split(secret).join("***") : text;
}

/**
 * 上游报错时**只回状态码和它的 error.code / error.type**。
 *
 * 为什么不回原文：这个接口不鉴权，而网关 401 的响应体里常带 key 片段、fetch 异常里
 * 带内部地址——那些不该出现在任何一个能敲到这条路由的人面前。原文（抹掉 key 之后）
 * 写服务端日志，排查的人去看日志；`error.code` 足够说清「模型名不对」还是「这把 key
 * 没有音频授权」，这正是配 key 时唯一要的那句话。
 */
function describeUpstreamError(status: number, raw: string): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    parsed = null;
  }
  const error = (parsed as { error?: { code?: unknown; type?: unknown } } | null)?.error;
  const marks = [error?.code, error?.type].filter((v): v is string => typeof v === "string" && v.length > 0);
  return marks.length > 0 ? `HTTP ${status} ${marks.join(" ")}` : `HTTP ${status}`;
}

export async function GET(req: Request) {
  if (crossSiteRequest(req)) return fail(403, "cross_origin_not_allowed");

  const text = (new URL(req.url).searchParams.get("text") ?? "").trim();
  if (!text) return fail(400, "missing_text");
  if (text.length > MAX_TEXT_LENGTH) return fail(413, "text_too_long", `上限 ${MAX_TEXT_LENGTH} 字符`);

  const apiKey = readEnv("MODELGATE_API_KEY");
  const baseUrl = readEnv("MODELGATE_TTS_BASE_URL");
  if (!apiKey || !baseUrl) {
    return fail(
      503,
      "tts_not_configured",
      "站点未配置 MODELGATE_API_KEY / MODELGATE_TTS_BASE_URL，页面会退回本机语音",
    );
  }

  const base = baseUrl.replace(/\/+$/, "");
  const model = readEnv("MODELGATE_TTS_MODEL") ?? DEFAULT_MODEL;
  const voice = readEnv("MODELGATE_TTS_VOICE") ?? DEFAULT_VOICE;

  const key = cacheKey(model, voice, text);
  const hit = cache.get(key);
  if (hit) {
    return new Response(hit.body, {
      headers: {
        "Content-Type": hit.contentType,
        "Cache-Control": "public, max-age=86400",
        "X-TTS-Source": "modelgate-cache",
      },
    });
  }

  let upstream: Response;
  try {
    upstream = await fetch(`${base}/v1/audio/speech`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ model, input: text, voice, response_format: RESPONSE_FORMAT }),
      // 上游卡住时不能一直占着这个请求：一句话的合成，20s 还没回就是出问题了
      signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
    });
  } catch (err) {
    // fetch 自己的异常文本里有上游地址，只进日志
    console.warn(`[tts] upstream unreachable: ${masked(String(err), apiKey)}`);
    return fail(502, "tts_upstream_unreachable");
  }

  if (!upstream.ok) {
    const raw = (await upstream.text().catch(() => "")).slice(0, 400);
    console.warn(`[tts] upstream ${upstream.status}: ${masked(raw, apiKey)}`);
    return fail(502, "tts_upstream_error", describeUpstreamError(upstream.status, raw));
  }

  let audio: ArrayBuffer;
  try {
    // 这一步也会被上面的 AbortSignal 打断（响应头已到、正文还在传）——不接住的话就是
    // 一个没有错误码的 500，绕开了这个路由设计好的失败口径。
    audio = await upstream.arrayBuffer();
  } catch (err) {
    console.warn(`[tts] upstream body read failed: ${masked(String(err), apiKey)}`);
    return fail(502, "tts_upstream_body_failed");
  }
  if (audio.byteLength === 0) return fail(502, "tts_upstream_empty");
  const contentType = upstream.headers.get("content-type") ?? FALLBACK_CONTENT_TYPE;
  remember(key, { body: audio, contentType });

  return new Response(audio, {
    headers: {
      "Content-Type": contentType,
      "Cache-Control": "public, max-age=86400",
      "X-TTS-Source": "modelgate",
    },
  });
}
