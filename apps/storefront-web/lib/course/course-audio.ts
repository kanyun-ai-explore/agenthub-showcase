/**
 * 课程里每一句读音从哪取（课程的 TTS 走平台的语音能力，站点不直调模型网关）。
 *
 * - 单元 1、2：读音经平台**预生成**（`scripts/course-audio/generate.mjs` → 朗读 agent
 *   edu-english-reader → 平台合成），转成 m4a 放在 `public/course-audio/`，清单 `units/audio.json`
 *   按原文查文件。运行时不发任何回合。
 * - 单元 3：题是课中生成的，读音**运行时**由站点经同一个朗读 agent 合成（`/api/course/audio`）。
 *   浏览器只告诉服务端「哪个会话的哪一轮出的题、第几道」，要念的文字由服务端从那一轮的
 *   `present_lesson` 里取（约束 1，见 `reader-guard.ts`），所以这里拼的是题的坐标，不是文字。
 * 两边都取不到时，页面退到浏览器本机语音并在题卡上标明。
 * 单元 3 一开始出题，页面还会先让站点把朗读会话建好（`requestReaderPrewarm`）。
 * 出题回合还在跑时只取首句（`prefetchClips`）：题一出现就要念的是它，等回合终态再取会把出题
 * 收尾那几秒算进它的等待里。
 *
 * lib/course 下的模块互不做值导入：清单是 JSON，题的类型只引类型。
 */

import manifest from "./units/audio.json" with { type: "json" };
import type { LessonContent } from "./english-lesson";

/** 单元 3 那一关是哪个会话的哪一轮出的（`useLessonChannel` 记下，回合终态后随本机存储一起存）。 */
export interface LessonOrigin {
  sessionId: string;
  turnId: string;
}

export interface Clip {
  /** 要念的那句原文：页面按它找读音，运行时的读音拿回来也要和它逐字相等才放。 */
  text: string;
  /** 取音频的地址；没有（单元 3 还没记下出处）就是 null，播的时候退到本机语音。 */
  src: string | null;
  kind: "static" | "runtime";
}

export const STATIC_AUDIO_BASE = "/course-audio/";

const STATIC = new Map<string, string>(
  (manifest as { clips: { text: string; file: string }[] }).clips.map((clip) => [clip.text, clip.file]),
);

/** 预生成的那一句（单元 1、2）在哪；不在清单里返回 null。 */
export function staticClipSrc(text: string): string | null {
  const file = STATIC.get(text);
  return file ? `${STATIC_AUDIO_BASE}${file}` : null;
}

/** 运行时那一句（单元 3）：题的坐标，不带文字。 */
export function runtimeClipSrc(origin: LessonOrigin, index: number): string {
  const q = new URLSearchParams({ session: origin.sessionId, turn: origin.turnId, i: String(index) });
  return `/api/course/audio?${q.toString()}`;
}

/** 预建朗读会话的站点路由（`app/api/course/reader-prewarm/route.ts`）。 */
export const READER_PREWARM_PATH = "/api/course/reader-prewarm";

/**
 * 让站点把这个 coach 会话的朗读会话先建好。只报会话 id；发不出去、站点拒了都不抛——预建没成，取音时站点
 * 照旧懒建。返回响应的状态码（发不出去是 0），只给页面的计时读数用。
 */
export async function requestReaderPrewarm(sessionId: string, fetchImpl: typeof fetch = fetch): Promise<number> {
  try {
    const res = await fetchImpl(READER_PREWARM_PATH, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sessionId }),
    });
    return res.status;
  } catch {
    return 0;
  }
}

/** 一关里要念的每一句：听音选词的 `audio_text`、跟读的 `text`。预生成过的那句优先用静态文件。 */
export function lessonClips(content: Pick<LessonContent, "exercises"> & { origin?: LessonOrigin }): Clip[] {
  const clips: Clip[] = [];
  content.exercises.forEach((exercise, index) => {
    const text = exercise.type === "listen_choice" ? exercise.audio_text : exercise.type === "read_aloud" ? exercise.text : null;
    if (!text) return;
    const stat = staticClipSrc(text);
    if (stat) clips.push({ text, src: stat, kind: "static" });
    else clips.push({ text, src: content.origin ? runtimeClipSrc(content.origin, index) : null, kind: "runtime" });
  });
  return clips;
}

/**
 * 这一关现在该预取哪几句。
 * - 到齐了（回合终态、静态关、本机存下的）：全部，`useSpeech` 按题序取。
 * - 回合还在跑（`complete` 为 false）：只取首句。这时的地址指向一轮没结束的回合，站点从工具已经收下的那次
 *   调用里取字、回 `no-store`；其余几句等终态再取（顺序照旧）——没结束的回合里多取一句，
 *   万一这一版后来被换掉就白耗一句限速额度。
 */
export function prefetchClips(content: Pick<LessonContent, "exercises" | "complete"> & { origin?: LessonOrigin }): Clip[] {
  const clips = lessonClips(content);
  return content.complete ? clips : clips.slice(0, 1);
}
