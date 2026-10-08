/**
 * 回合音频的**读**与**播**（情景对话用；跟读卡改版后只要文字点评，不再取音频）。
 *
 * 读：`GET /api/agenthub/turn-audio`。它回的是四种**状态**，不是「成功/失败」——
 * `TURN_AUDIO_NOT_FOUND`（agent 那一版没声明 `voice.output`）在平台口径里是一个值，
 * 页面据此说「这一轮没有音频点评」而不是报错。所以这一层把 HTTP 结果整段翻成状态，
 * 从不抛（网络层的意外落成 `failed`）。
 *
 * 播：段是 OSS 的短时签名 URL，一次一排、顺序播完，任一段放不出来就交给调用方——
 * 自动播放被浏览器拦下来是最常见的一种，那**不是**「没有音频」，页面得保住「再点一次」
 * 的按钮（`playSegments` 抛出去，调用方决定怎么显示）。
 *
 * 段的 content-type 由平台存段时定，眼下写死 `audio/mpeg`；qwen 合成实际回 WAV，`<audio>`
 * 靠浏览器按内容识别（读数见 agenthub/agents/edu-english-roleplay/agent.yaml 的注释）。
 */

/** 平台读接口的返回值：第几段 + 签名 URL。 */
export interface AudioSegment {
  index: number;
  url: string;
}

export type TurnAudio =
  | { status: "ready"; segments: AudioSegment[] }
  /** 合成还在路上（平台回 pending，或还没合成出段）。 */
  | { status: "pending" }
  /** 这一轮平台就没有音频（没声明 `voice.output`）。这是值，不是错误。 */
  | { status: "none" }
  | { status: "failed"; code?: string };

/**
 * 读一轮的音频。`wait=1` 时服务端会等一小会儿合成（路由里的 20 s 上限），超时或被拒都
 * 落成状态；这里不做重试——重试是页面上那个按钮的活。
 */
export async function readTurnAudio(sessionId: string, turnId: string): Promise<TurnAudio> {
  try {
    const res = await fetch(
      `/api/agenthub/turn-audio?sessionId=${encodeURIComponent(sessionId)}&turnId=${encodeURIComponent(turnId)}&wait=1`,
    );
    const data = (await res.json().catch(() => ({}))) as {
      status?: string;
      segments?: AudioSegment[];
      error?: string;
    };
    if (!res.ok) {
      return data.error === "TURN_AUDIO_NOT_FOUND" ? { status: "none" } : { status: "failed", code: data.error };
    }
    const segments = (data.segments ?? []).slice().sort((a, b) => a.index - b.index);
    if (data.status === "ready" && segments.length > 0) return { status: "ready", segments };
    if (data.status === "failed") return { status: "failed" };
    return segments.length > 0 ? { status: "ready", segments } : { status: "pending" };
  } catch {
    return { status: "failed", code: "NETWORK_ERROR" };
  }
}

/**
 * 顺序播一串段。`onSegment` 每段开播前报一次（页面用它画「正在播第几段 / 在播哪一条」），
 * 全部播完才算成功；中途任一段失败就抛——**段还在手里**，调用方该保住重播的路。
 */
export async function playSegments(
  segments: readonly AudioSegment[],
  element: HTMLAudioElement,
  onSegment?: (index: number | null) => void,
): Promise<void> {
  try {
    for (const segment of segments) {
      onSegment?.(segment.index);
      element.src = segment.url;
      await new Promise<void>((resolve, reject) => {
        element.onended = () => {
          element.onended = null;
          element.onerror = null;
          resolve();
        };
        element.onerror = () => {
          element.onended = null;
          element.onerror = null;
          reject(new Error("segment_playback_failed"));
        };
        element.play().catch((err: unknown) => {
          element.onended = null;
          element.onerror = null;
          reject(err instanceof Error ? err : new Error(String(err)));
        });
      });
    }
  } finally {
    onSegment?.(null);
  }
}
