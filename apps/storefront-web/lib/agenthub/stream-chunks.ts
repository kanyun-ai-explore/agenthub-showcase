/**
 * `sessions.streamEvents` 的 chunk 结构。
 *
 * SDK 把 chunk 标成 `unknown`，所以这些类型不是抄声明文件，是从真实一轮抓下来的
 * （一次真实会话的 808 条事件），下面每种都实际观察到过。
 *
 * 抓出来的关键事实：reasoning-delta 662 条（seq 4…695）在 text-delta 109 条
 * （seq 697…805）之前 —— 正文要到整轮 86% 才开始。所以只流正文没用，真正有内容
 * 可显示的是工具轨迹，`tool-output-available` 还直接带着卡片数据。
 *
 * 终态判定归 waitForTurn，不归这条流。
 */

export type StreamChunk =
  | { type: "start" }
  | { type: "start-step" }
  | { type: "finish-step"; usage?: unknown }
  | { type: "finish"; totalUsage?: unknown }
  | { type: "reasoning-start"; id: string }
  | { type: "reasoning-delta"; id: string; delta: string }
  | { type: "reasoning-end"; id: string }
  | { type: "text-start"; id: string }
  | { type: "text-delta"; id: string; delta: string }
  | { type: "text-end"; id: string }
  | { type: "tool-input-start"; toolCallId: string; toolName: string }
  | { type: "tool-input-delta"; toolCallId: string; delta: string }
  | { type: "tool-input-available"; toolCallId: string; toolName: string; input: unknown }
  | { type: "tool-output-available"; toolCallId: string; output: unknown };

/** What the browser receives on the proxied SSE stream — the SDK's own envelope. */
export interface StreamFrame {
  seq: number;
  chunk: StreamChunk;
}

/** Narrows an untrusted parsed frame. Anything unrecognised is dropped, not guessed:
 * a new chunk type appearing upstream must not crash the thread. */
export function asStreamChunk(value: unknown): StreamChunk | null {
  if (typeof value !== "object" || value === null) return null;
  const type = (value as { type?: unknown }).type;
  return typeof type === "string" ? (value as StreamChunk) : null;
}
