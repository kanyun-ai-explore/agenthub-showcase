/**
 * 回合音频的**读**与**播**在浏览器里的那一层（情景对话用；跟读卡改版后只要文字点评，
 * 不再取音频）。怎么排段、什么时候停，在 `turn-audio-player.ts`；这里只把它要的两个动作接到
 * `fetch` 和 `<audio>` 上。
 *
 * 读：`GET /api/agenthub/turn-audio?wait=0`（`getTurnAudio`，只读一次）。它回的是**状态**，
 * 不是「成功/失败」——`TURN_AUDIO_NOT_FOUND`（404）在合成触发之前是「还没有」，回合终态
 * 之后一直是它才是「这一版 agent 没声明 `voice.output`」，所以这里只把它标成 `not_found`，
 * 判哪一种是播放器按时间判的。从不抛（网络层的意外落成 `error`）。
 *
 * 播：段是 OSS 的短时签名 URL，一次一段。自动播放被浏览器拦下来（`NotAllowedError`）是最
 * 常见的放不出来，那**不是**「没有音频」，单独回 `blocked`，页面得保住「再点一次」的按钮。
 *
 * 段的 content-type 由平台存段时定；qwen 合成实际回 WAV，`<audio>` 靠浏览器按内容识别
 * （读数见 agenthub/agents/edu-english-roleplay/agent.yaml 的注释）。
 */

import type { AudioRead, PlayerSegment, SegmentPlayResult } from "./turn-audio-player";

/** 读一轮的音频，只读一次（`wait=0`）。 */
export async function readTurnAudioOnce(sessionId: string, turnId: string): Promise<AudioRead> {
  try {
    const res = await fetch(
      `/api/agenthub/turn-audio?sessionId=${encodeURIComponent(sessionId)}&turnId=${encodeURIComponent(turnId)}&wait=0`,
    );
    const data = (await res.json().catch(() => ({}))) as {
      status?: string;
      segments?: PlayerSegment[];
      failure?: { reason?: string };
      error?: string;
    };
    if (!res.ok) {
      return data.error === "TURN_AUDIO_NOT_FOUND" ? { kind: "not_found" } : { kind: "error", code: data.error ?? `HTTP_${res.status}` };
    }
    const status = data.status === "ready" || data.status === "failed" ? data.status : "pending";
    const segments = (data.segments ?? [])
      .filter((s) => Number.isInteger(s?.index) && typeof s?.url === "string")
      .map((s) => ({ index: s.index, url: s.url }))
      .sort((a, b) => a.index - b.index);
    return { kind: "audio", status, segments, ...(data.failure?.reason ? { failure: data.failure.reason } : {}) };
  } catch {
    return { kind: "error", code: "NETWORK_ERROR" };
  }
}

/** 一段的播放时刻钩子（页面记 canplay / 开始播放用）。 */
export interface SegmentHooks {
  onCanPlay?: (index: number) => void;
  onPlaying?: (index: number) => void;
}

/**
 * 在同一个 `<audio>` 上放一段，放完 / 放不出来 / 被取消时 resolve，从不 reject。取消
 * （`signal`）时先摘回调再 pause，被打断的这一段不会再回报任何事件。
 */
export function playSegmentOn(
  element: HTMLAudioElement,
  segment: PlayerSegment,
  signal: AbortSignal,
  hooks: SegmentHooks = {},
): Promise<SegmentPlayResult> {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve("cancelled");
      return;
    }
    let finished = false;
    const finish = (result: SegmentPlayResult) => {
      if (finished) return;
      finished = true;
      element.oncanplay = null;
      element.onplaying = null;
      element.onended = null;
      element.onerror = null;
      signal.removeEventListener("abort", onAbort);
      resolve(result);
    };
    const onAbort = () => {
      finish("cancelled");
      element.pause();
    };
    signal.addEventListener("abort", onAbort);
    element.oncanplay = () => hooks.onCanPlay?.(segment.index);
    element.onplaying = () => hooks.onPlaying?.(segment.index);
    element.onended = () => finish("ended");
    element.onerror = () => finish("error");
    element.src = segment.url;
    element.play().catch((err: unknown) => {
      // DOMException 在老 WebKit 上不一定 instanceof Error，按 name 认。
      finish((err as { name?: unknown } | null)?.name === "NotAllowedError" ? "blocked" : "error");
    });
  });
}
