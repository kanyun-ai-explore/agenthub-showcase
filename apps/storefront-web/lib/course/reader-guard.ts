/**
 * 送给朗读 agent（edu-english-reader）的文字守在哪：只能是课程里一道题要念的那句英文。
 *
 * 站点侧的硬约束（编号跨文件共用，2 和一部分 3、5 在 `reader-service.ts`）：
 * 1. 文字只来自服务端的课程内容、按题取，浏览器不提交要念的字符串——见 `/api/course/audio`：
 *    浏览器只给「哪个会话的哪一轮出的题、第几道」，文字由服务端从那一轮的 `present_lesson` 里取；
 * 3. 限长度、限字符集（本文件）；按会话限速（`reader-service.ts`）；
 * 4. 单元 3 的题送 reader 之前按 course-units 的口径校验（本文件：听音最多 6 个词、跟读 3–8 个词，
 *    和 `scripts/course-units/check.mjs` 的 LC_MAX_WORDS / READ_WORDS 同数）；
 * 5. 回合正文和原文严格相等才用（`isExactEcho`）。
 * 单元 1、2 的读音是预生成的，预生成脚本也过这一道，口径一致。
 *
 * 纯函数，`scripts/course-audio/check.mjs` 直接 import 跑用例。lib/course 下的模块互不做值导入，
 * 题的类型只引类型。
 */

import type { Exercise } from "./english-lesson";

/** 一句读音的长度上限（字符）。B1 的句子 3–8 个词，60 个字符以内；留一点余量，再长就不是一道题的读音了。 */
export const READER_TEXT_MAX = 80;
/** 听音选词最多几个词（course-units 的 LC_MAX_WORDS）。 */
export const LISTEN_MAX_WORDS = 6;
/** 跟读几个词（course-units 的 READ_WORDS）。 */
export const READ_WORDS = [3, 8] as const;

/** 只放英文字母、数字、空格和句子里常见的几个标点。弯引号 ’ 收（模型常写 I’m），别的一律不收。 */
const ALLOWED = /^[A-Za-z0-9 ,.'’?!-]+$/;

export type ReaderText = { ok: true; text: string } | { ok: false; reason: string };

const words = (text: string) => text.split(" ").filter(Boolean).length;

/** 一句话本身能不能送去念：长度、字符集、空白。 */
export function checkReaderText(text: string): ReaderText {
  if (text.length === 0) return { ok: false, reason: "empty" };
  if (text !== text.trim() || /\s{2,}/.test(text) || /[\t\n\r]/.test(text)) return { ok: false, reason: "whitespace" };
  if (text.length > READER_TEXT_MAX) return { ok: false, reason: "too_long" };
  if (!ALLOWED.test(text)) return { ok: false, reason: "charset" };
  return { ok: true, text };
}

/**
 * 一道题要念的那句：听音选词念 `audio_text`，跟读念 `text`（例句）。别的题型不念。
 * 先过 `checkReaderText`，再按题型卡词数。
 */
export function readerTextFor(exercise: Exercise | undefined): ReaderText {
  if (!exercise) return { ok: false, reason: "no_exercise" };
  const text = exercise.type === "listen_choice" ? exercise.audio_text : exercise.type === "read_aloud" ? exercise.text : null;
  if (text === null) return { ok: false, reason: "not_spoken" };
  const base = checkReaderText(text);
  if (!base.ok) return base;
  const n = words(text);
  if (exercise.type === "listen_choice" && n > LISTEN_MAX_WORDS) return { ok: false, reason: "too_many_words" };
  if (exercise.type === "read_aloud" && (n < READ_WORDS[0] || n > READ_WORDS[1])) return { ok: false, reason: "read_words" };
  return { ok: true, text };
}

/** 一关 8 道，加上可能多出来的几道：超过这个下标的就不是一道题。 */
export const MAX_QUESTION_INDEX = 15;

/**
 * 题的下标（`/api/course/audio` 的 `i`）：只收 0–15 的整数。缺参数、空串都不算 0——`Number(null)`、
 * `Number("")` 都是 0，直接 Number() 会让缺 `i` 的请求冒充第 0 道。
 */
export function parseQuestionIndex(raw: string | null): number | null {
  if (raw === null || !/^\d{1,2}$/.test(raw)) return null;
  const index = Number(raw);
  return index <= MAX_QUESTION_INDEX ? index : null;
}

/** 朗读回合的正文和原文严格相等才用（只去掉首尾空白）：念出来的必须就是题目里写的那句。 */
export function isExactEcho(reply: string | undefined, text: string): boolean {
  return (reply ?? "").trim() === text;
}
