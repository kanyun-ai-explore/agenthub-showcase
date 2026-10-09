/**
 * 单元 3 的运行时读音：服务端经朗读 agent（edu-english-reader，format: live，只声明 voice.output）
 * 把一句英文合成成语音。只给 `/api/course/audio` 用，浏览器碰不到这里的任何东西。
 *
 * 站点侧约束（约束表见 `reader-guard.ts`）落在这里的是：
 * - 2：reader **不走**通用的 `/api/agenthub/turn`，**不进** `AGENT_ENV`（workload id 单独一个环境变量
 *   `AGENTHUB_ENGLISH_READER_AGENT_ID`），会话 id 只在这个进程的内存里，不回给浏览器；
 * - 3：按学员的 coach 会话限速（只数真正发出去的回合，命中缓存不算）；
 * - 5：回合正文和原文严格相等才用（`isExactEcho`），不等重来一次，再不等就报错不播。
 * 文字本身（约束 1、4）由路由从课程内容里取、先过 `reader-guard.ts`，这里只收已经过了守卫的句子。
 *
 * 会话怎么开：每个学员（按他的 coach 会话）一个 reader 会话，懒建；平台一个会话同一时刻只跑一个回合，
 * 所以同一个 reader 会话上的回合排成一条链。会话用满 `MAX_TURNS` 轮换一个新的（live 会话的上下文
 * 会一直长），闲置超过 `IDLE_MS` 的在下一次调用时顺手 terminate。这些状态都在本进程内存里：
 * 站点多副本时各副本各开各的，正确性不受影响，只是同一句可能在两个副本各合成一次。
 *
 * 合成结果按原文缓存（进程内 LRU）：同一句话不论哪个学员要，都只合成一次。
 */

import { getAgentHubClient } from "@/lib/agenthub/client";
import { isExactEcho } from "@/lib/course/reader-guard";
import { concatWav } from "@/lib/course/wav";

export const READER_AGENT_ENV = "AGENTHUB_ENGLISH_READER_AGENT_ID";

/** 一个 reader 会话最多跑多少轮就换新的。 */
const MAX_TURNS = 40;
/** 闲置多久的 reader 会话 terminate 掉。 */
const IDLE_MS = 20 * 60_000;
/** 限速：每个 coach 会话在这个窗口里最多发多少个朗读回合。单元 3 一关 4 句，五关 20 句，留出重试的余量。 */
const RATE_WINDOW_MS = 10 * 60_000;
const RATE_LIMIT = 30;
/** 缓存条数：一句 1–3 s 的 WAV 约 50–150 KB，128 条十几 MB。 */
const CACHE_LIMIT = 128;
/** 一个朗读回合（出字 + 合成）的等待上限：test 槽实测段 0 在派发后 1.9–2.8 s。 */
const TURN_TIMEOUT_MS = 45_000;

export type ReaderErrorCode = "not_configured" | "rate_limited" | "echo_mismatch" | "audio_failed" | "upstream";

export class ReaderError extends Error {
  constructor(
    readonly code: ReaderErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "ReaderError";
  }
}

export interface ReaderAudio {
  body: ArrayBuffer;
  contentType: string;
}

interface ReaderSession {
  id: string;
  turns: number;
  lastUsed: number;
  /** 这个会话上排着的回合：一个跑完下一个才发。 */
  tail: Promise<unknown>;
}

const sessions = new Map<string, ReaderSession>();
/**
 * 正在开的 reader 会话：同一个学员的两句同时没命中缓存时，第二句等第一句开的那个会话，不再自己开一个。
 * 没有这一层时，test 槽上实测同一个 coach 会话在 30 ms 内开了两个 reader 会话，后开的盖掉
 * 前一个的登记，前一个就没人收了。
 */
const opening = new Map<string, Promise<ReaderSession>>();
const cache = new Map<string, ReaderAudio>();
const inflight = new Map<string, Promise<ReaderAudio>>();
const sent = new Map<string, number[]>();

/** reader 的 workload id；没配就是 null（页面退到本机语音）。空串当没配。 */
export function readerAgentId(): string | null {
  const value = process.env[READER_AGENT_ENV]?.trim();
  return value ? value : null;
}

function remember(text: string, audio: ReaderAudio): void {
  if (cache.size >= CACHE_LIMIT) {
    const oldest = cache.keys().next();
    if (!oldest.done) cache.delete(oldest.value);
  }
  cache.set(text, audio);
}

/** 限速判据：窗口内已发的回合数。超了抛 rate_limited；没超就记一笔。 */
function takeRate(key: string, now: number): void {
  const recent = (sent.get(key) ?? []).filter((t) => now - t < RATE_WINDOW_MS);
  if (recent.length >= RATE_LIMIT) {
    sent.set(key, recent);
    throw new ReaderError("rate_limited", `这个会话 ${RATE_WINDOW_MS / 60_000} 分钟内已经合成了 ${recent.length} 句`);
  }
  recent.push(now);
  sent.set(key, recent);
}

async function terminate(sessionId: string): Promise<void> {
  // 地址取 SDK 解析好的那个（构造参数 → 环境变量 → SDK 默认值），代码里不写死控制面地址。
  const { env, client } = getAgentHubClient();
  const base = client.controlPlaneUrl.replace(/\/+$/, "");
  try {
    await fetch(`${base}/api/sessions/${sessionId}/terminate`, {
      method: "POST",
      headers: { Authorization: `Bearer ${env.token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ reason: "reader idle or rotated" }),
      signal: AbortSignal.timeout(10_000),
    });
  } catch (err) {
    console.warn(`[course/reader] terminate ${sessionId} failed: ${String(err)}`);
  }
}

/** 闲置太久的会话收掉（不等它们，失败只记日志）。 */
function sweep(now: number): void {
  for (const [key, session] of sessions) {
    if (now - session.lastUsed > IDLE_MS) {
      sessions.delete(key);
      void terminate(session.id);
    }
  }
  for (const [key, times] of sent) {
    if (times.every((t) => now - t >= RATE_WINDOW_MS)) sent.delete(key);
  }
}

async function openSession(key: string, agentId: string): Promise<ReaderSession> {
  const { env, client } = getAgentHubClient();
  const created = await client.sessions.create({
    projectId: env.projectId,
    agentId,
    stage: env.stage,
    user: { id: `reader-${key}` },
  });
  await client.sessions.wait(created.sessionId, { timeoutMs: 60_000 });
  const session: ReaderSession = { id: created.sessionId, turns: 0, lastUsed: Date.now(), tail: Promise.resolve() };
  sessions.set(key, session);
  return session;
}

async function sessionFor(key: string, agentId: string): Promise<ReaderSession> {
  const existing = sessions.get(key);
  if (existing && existing.turns < MAX_TURNS) return existing;
  const pending = opening.get(key);
  if (pending) return pending;
  if (existing) {
    sessions.delete(key);
    // 轮换时旧会话上可能还有回合在飞、或者排在它的链上：等这条链走完再收，不把它们中途掐掉。
    void existing.tail.then(() => terminate(existing.id));
  }
  const open = openSession(key, agentId).finally(() => opening.delete(key));
  opening.set(key, open);
  return open;
}

const replyOf = (parts: unknown): string =>
  (Array.isArray(parts) ? parts : [])
    .filter((p): p is { type: string; text: string } => typeof p === "object" && p !== null && (p as { type?: unknown }).type === "text")
    .map((p) => p.text)
    .join("");

/** 在这个会话上念一句：回合正文必须和原文严格相等，再取所有段拼成一段。 */
async function speakOnce(session: ReaderSession, text: string): Promise<ReaderAudio> {
  const { client } = getAgentHubClient();
  session.turns += 1;
  session.lastUsed = Date.now();
  const turn = await client.sessions.sendTurn(session.id, { text });
  if (turn.kind === "revival_in_progress") throw new ReaderError("upstream", "reader 会话正在恢复");
  const { turn: settled } = await client.sessions.waitForTurn(session.id, turn.turnId, { timeoutMs: TURN_TIMEOUT_MS });
  if (!isExactEcho(replyOf(settled.assistant?.parts), text)) {
    throw new ReaderError("echo_mismatch", "朗读回合的正文和原文不一致");
  }
  const audio = await client.sessions.waitForTurnAudio(session.id, turn.turnId, { timeoutMs: TURN_TIMEOUT_MS });
  if (audio.status !== "ready" || audio.segments.length === 0) {
    throw new ReaderError("audio_failed", `合成没成：${audio.status}${audio.failure ? ` ${audio.failure.reason}` : ""}`);
  }
  const segments = [...audio.segments].sort((a, b) => a.index - b.index);
  const parts: Uint8Array[] = [];
  for (const segment of segments) {
    // 段是 OSS 的短时签名 URL（600 s 过期）：立刻取回来，缓存的是字节，不是 URL。
    const res = await fetch(segment.url, { signal: AbortSignal.timeout(15_000) });
    if (!res.ok) throw new ReaderError("audio_failed", `取段 ${segment.index} 失败：HTTP ${res.status}`);
    parts.push(new Uint8Array(await res.arrayBuffer()));
  }
  const wav = concatWav(parts);
  if (!wav) throw new ReaderError("audio_failed", "段不是 WAV，或者几段的格式不一样");
  return { body: wav.slice().buffer as ArrayBuffer, contentType: "audio/wav" };
}

/**
 * 念一句（已过 `reader-guard` 的守卫）。`key` 是学员的 coach 会话 id：reader 会话和限速都按它分。
 * 命中缓存直接回；同一句正在合成就等那一次；否则限速、排进这个学员的 reader 会话。
 */
export async function readClip(key: string, text: string): Promise<{ audio: ReaderAudio; source: "cache" | "reader" }> {
  const agentId = readerAgentId();
  if (!agentId) throw new ReaderError("not_configured", `站点没有配置 ${READER_AGENT_ENV}`);
  const hit = cache.get(text);
  if (hit) return { audio: hit, source: "cache" };
  const pending = inflight.get(text);
  if (pending) return { audio: await pending, source: "reader" };

  const now = Date.now();
  sweep(now);
  takeRate(key, now);

  const job = (async () => {
    const session = await sessionFor(key, agentId);
    const run = session.tail.then(async () => {
      try {
        return await speakOnce(session, text);
      } catch (err) {
        // 不复述（模型偶尔多写一个字）重来一次；别的错误不重试。
        if (err instanceof ReaderError && err.code === "echo_mismatch") return speakOnce(session, text);
        throw err;
      }
    });
    session.tail = run.catch(() => undefined);
    const audio = await run;
    remember(text, audio);
    return audio;
  })();
  inflight.set(text, job);
  try {
    return { audio: await job, source: "reader" };
  } finally {
    inflight.delete(text);
  }
}
