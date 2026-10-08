"use client";

/**
 * 对话引擎，各个 case 的手机 App 共用。三个真相来源分开：
 *
 * - SSE 只管「跑的时候看到什么」——工具轨迹、卡片、逐字正文，不带生命周期语义。
 * - `POST /api/agenthub/turn`（服务端 await waitForTurn）是权威，返回后整体替换
 *   流式画的内容，所以掉线最多损失动画。
 * - `GET /api/agenthub/session/<id>` 只管就绪。沙箱启动期间输入框可用，就绪后
 *   自动发出——让人对着禁用的输入框等 20 秒不是安全性，是糟糕的第一印象。
 *
 * 聊天类界面用 `send`（发了就不管，渲染读 `messages`）；英语课这种自己排回合的界面用
 * `ask` / `sendVoice`——同一条管道（SSE、能力面板的信号都照走），只是把这一轮的结果
 * 交回调用方。两者共用「同一时刻只有一个回合」这条约束：在飞时再发会被拒，排队是调用方的事。
 */

import { useCallback, useEffect, useRef, useState } from "react";
import type { AgentKey } from "@/lib/agenthub/client";
import type { VoiceTake } from "@/lib/agenthub/voice-recording";
import { voiceErrorMessage } from "@/lib/agenthub/voice-errors";
import type { TurnCard } from "@/lib/agenthub/turn-parts";
import { cardsFromEnvelope, parseUiEnvelope } from "@/lib/agenthub/turn-parts";
import { describeTool, type ToolKind } from "@/lib/agenthub/tool-labels";
import { asStreamChunk, type StreamFrame } from "@/lib/agenthub/stream-chunks";
import { clearPrewarmHandle, readPrewarmHandle } from "@/lib/agenthub/prewarm-handle";
import type { CapabilitySignal } from "@/lib/showcase/capabilities";

/** 跨 agent 预热事件：prewarm-hit / prewarm-miss 由本 hook 在 start() 里发出；
 *  prewarm-started 由 CaseStage 预建兄弟 agent 会话时自己记入 events。 */
export type PrewarmSignal = "prewarm-hit" | "prewarm-miss" | "prewarm-started";

export type ConversationSignal = CapabilitySignal | PrewarmSignal;

export interface TraceItem {
  id: string;
  label: string;
  kind: ToolKind;
  done: boolean;
}

export type Message =
  | { role: "user"; id: string; text: string }
  | { role: "system"; id: string; text: string }
  | {
      role: "agent";
      id: string;
      text: string;
      cards: TurnCard[];
      trace: TraceItem[];
      /** Live reasoning, shown behind a toggle; cleared once the turn settles. */
      thinking: string;
      /**
       * 这一轮跑到哪个阶段了（只看流，不带生命周期语义）：`start` = 平台已经开跑、
       * `thinking` = 在出思考、`writing` = 在出正文、`tool` = 在写工具入参。页面拿它给
       * 「老师在准备 / 在想」这类阶段提示——实测工具入参不是流式的，生成入参的
       * 那十来秒里一个事件都没有，能显示的只有阶段。
       */
      stage?: "start" | "thinking" | "writing" | "tool";
      /**
       * 这一轮**所有**工具调用，按发起顺序（同一个 toolCallId 只占一项，入参到了就补上）。
       * `draft` 只留最近一次：两次调用在同一条消息里并行发出、或者一次被拒后重调时，前一次的
       * 入参就看不到了。英语课按它把一关的几批拼起来。
       */
      drafts?: { toolCallId: string; toolName: string; input?: unknown }[];
      /**
       * 最近一次工具调用：`tool-input-start` 时只有名字，`tool-input-available` 时带上完整入参。
       * 英语课在入参到的那一刻就能画题（不等工具执行完、结果回来）。
       */
      draft?: { toolCallId: string; toolName: string; input?: unknown };
      streaming: boolean;
      failed?: boolean;
      /**
       * 这一轮在平台上的 turnId（终态响应里就有）。页面上要按轮取**回合音频**时用它
       * ——情景对话里 agent 的每一句话都要能被播出来/重听；不取音频的页面不用管它。
       */
      turnId?: string;
    };

export type SessionPhase =
  | "idle" // nothing started yet
  | "creating"
  | "starting" // sandbox booting
  | "ready"
  | "reviving" // idle-reclaimed, Agent Recovery in flight
  | "unconfigured"
  | "error";

/** 一轮文字回合（`ask`）的结果。`ok` = 回合到了 `completed`。 */
export interface AskOutcome {
  ok: boolean;
  status?: string;
  replyText?: string;
  cards?: TurnCard[];
  code?: string;
  error?: string;
}

/** 语音回合里 agent 那一半：回复文字（终态）。 */
export interface VoiceReply {
  ok: boolean;
  status?: string;
  replyText?: string;
  /** 回合上的 `user.text`。voice-turn 那一跳没读到转写时，从这里补。 */
  transcript?: string;
  code?: string;
}

/**
 * 一轮语音回合的结果，**分两段到**：转写在派发后就回来（`transcript`），agent 的回复
 * 另外到（`reply`）——页面先画逐词比对，不等回复。`reply` 落定之前会话仍算占用（`busy`），
 * 下一轮要等它。`ok: false` 时 `error` 是可以直接给孩子看的中文，`code` 是平台的稳定
 * 错误码（要另做判断时用它，别去解析文案）。
 */
export interface VoiceTurnOutcome {
  ok: boolean;
  turnId?: string;
  /** 平台对这段录音的转写——agent 看到的也是它。`null` = 派发那一跳没读到，等 `reply.transcript`。 */
  transcript?: string | null;
  reply?: Promise<VoiceReply>;
  code?: string;
  error?: string;
}

export interface Conversation {
  phase: SessionPhase;
  sessionId: string | null;
  /** 这条会话在 AgentHub 门户里的落点（Sessions 主视图带 inspector）；服务端没配 projectId 时是 null。 */
  portalHref: string | null;
  /** 这次会话的终端用户身份：命中预热池时是平台铸的 EUID，否则是页面传入的访客 id。 */
  userId: string | null;
  messages: Message[];
  /** A turn is in flight (or queued waiting for the sandbox). */
  busy: boolean;
  /** Seconds since the session started booting — shown so the wait is legible. */
  elapsed: number;
  error: string | null;
  start: () => void;
  send: (text: string) => void;
  /** 发一轮文字、等它终态、把结果交回来。有回合在飞时直接回 `SESSION_TURN_IN_PROGRESS`。 */
  ask: (text: string) => Promise<AskOutcome>;
  /** 语音回合（跟读）：一段录好的音走站点自己的 /api/agenthub/voice-turn。 */
  sendVoice: (take: VoiceTake) => Promise<VoiceTurnOutcome>;
}

interface Options {
  agent: AgentKey;
  /** 页面自己的访客身份。购物侧只在会话没拿到平台 EUID 时作为冷启回退用；会话真正
   *  用的身份以返回的 `userId` 为准。 */
  endUserId?: string | null;
  /** 某个能力被真的观察到时触发，绝不预判。 */
  onSignal?: (signal: ConversationSignal, detail?: string) => void;
  /** 一轮结束——agent 可能写过购物车或记忆。 */
  onSettled?: () => void;
  /**
   * 冷启时就绪轮询的间隔（默认 1500 ms）。英语课传 300：没命中预热时
   * 孩子在等第一关，轮询间隔直接叠在等待上。其它视角不变。
   */
  readyPollMs?: number;
}

let idSeq = 0;
const nextId = () => `m${++idSeq}`;

/**
 * 转写是空的时，对话里那条 user 消息显示的占位文本。
 *
 * 导出的原因：**小结卡要能把它与「学员真说了话但转写为空」区分开**——情景对话把这条
 * 当成「没听清」那一轮（`missedTurns`），而不是一句空话。两边各写一个字符串迟早会漂。
 */
export const EMPTY_TRANSCRIPT_TEXT = "（没听清）";

export function useAgentConversation({ agent, endUserId, onSignal, onSettled, readyPollMs = 1500 }: Options): Conversation {
  const [phase, setPhase] = useState<SessionPhase>("idle");
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [portalHref, setPortalHref] = useState<string | null>(null);
  const [userId, setUserId] = useState<string | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [busy, setBusy] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const [error, setError] = useState<string | null>(null);

  // Refs, not state: the SSE handler and the poll loop read these from inside
  // closures that must not re-subscribe every render.
  const pendingIdRef = useRef<string | null>(null);
  const queuedRef = useRef<string | null>(null);
  const lastSeqRef = useRef(0);
  const chatSessionIdRef = useRef<string>("");
  const startedRef = useRef(false);
  const signalRef = useRef(onSignal);
  const settledRef = useRef(onSettled);
  signalRef.current = onSignal;
  settledRef.current = onSettled;

  const signal = useCallback((s: ConversationSignal, detail?: string) => {
    signalRef.current?.(s, detail);
  }, []);

  const push = useCallback((message: Message) => {
    setMessages((prev) => [...prev, message]);
  }, []);

  /** Mutates the in-flight agent message; a no-op once it has been replaced. */
  const patchPending = useCallback(
    (fn: (m: Extract<Message, { role: "agent" }>) => Extract<Message, { role: "agent" }>) => {
      const id = pendingIdRef.current;
      if (!id) return;
      setMessages((prev) =>
        prev.map((m) => (m.id === id && m.role === "agent" ? fn(m) : m)),
      );
    },
    [],
  );

  // ── session creation + readiness ────────────────────────────────────────────

  const start = useCallback(() => {
    if (startedRef.current) return;
    startedRef.current = true;
    setPhase("creating");
    setPortalHref(null);
    chatSessionIdRef.current = `web-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

    void (async () => {
      try {
        // 跨 agent 预热：同一个人从另一门课切过来时，页面前一步已经用
        // /api/agenthub/session/prewarm 为这个身份预建了本 agent 的会话。先查平台
        // 当前状态：ready 直接采纳；还在启动/建就交给轮询 effect 接管；只有明显
        // 失败（404/failed/恢复中）才清掉句柄走下面的正常冷启。
        if (endUserId) {
          const handle = readPrewarmHandle(agent, endUserId);
          if (handle) {
            const waitMs = Date.now() - handle.createdAt;
            try {
              const res = await fetch(`/api/agenthub/session/${handle.sessionId}`);
              // 该路由对错误只回 409/422/500（errorResponse），从不 404：任何非 2xx 都当
              // 「预热会话不可用」，绝不能把错误响应的 undefined status 当成「启动中」采纳。
              if (!res.ok) {
                signal("prewarm-miss", `预热的会话不可用（HTTP ${res.status}）`);
                clearPrewarmHandle(agent);
              } else {
                const data = (await res.json()) as {
                  status?: string | null;
                  pendingRevival?: unknown;
                };
                if (data.status === "ready" && !data.pendingRevival) {
                  setSessionId(handle.sessionId);
                  setUserId(handle.userId);
                  setPhase("ready");
                  signal("session-created", handle.sessionId);
                  signal("prewarm-hit", `${agent} 预热于 ${Math.round(waitMs / 1000)}s 前，等待 ${waitMs}ms`);
                  signal("sandbox-ready");
                  clearPrewarmHandle(agent);
                  return;
                }
                if (typeof data.status === "string" && !data.pendingRevival && data.status !== "failed") {
                  setSessionId(handle.sessionId);
                  setUserId(handle.userId);
                  setPhase("starting");
                  signal("prewarm-hit", "采用启动中的预热会话");
                  clearPrewarmHandle(agent);
                  return;
                }
                signal(
                  "prewarm-miss",
                  data.pendingRevival ? "预热的会话正在恢复" : `预热的会话状态异常：${data.status ?? "未知"}`,
                );
                clearPrewarmHandle(agent);
              }
            } catch (err) {
              signal("prewarm-miss", `查询预热会话失败：${err instanceof Error ? err.message : String(err)}`);
              clearPrewarmHandle(agent);
            }
          }
        }
        const res = await fetch("/api/agenthub/session", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            agent,
            chatSessionId: chatSessionIdRef.current,
            ...(endUserId ? { endUserId } : {}),
          }),
        });
        if (res.status === 501) {
          setPhase("unconfigured");
          return;
        }
        const data = (await res.json()) as {
          agentHubSessionId?: string;
          status?: string;
          userId?: string;
          detail?: string;
        };
        if (!data.agentHubSessionId) {
          setPhase("error");
          setError(data.detail ?? "会话创建失败");
          return;
        }
        setSessionId(data.agentHubSessionId);
        if (data.userId) setUserId(data.userId);
        signal("session-created", data.agentHubSessionId);
        // A session leased from the prewarming pool is `ready` in the create response
        // itself; there is nothing to poll for (the platform has no readiness push —
        // `GET /session/<id>` is the one readiness signal it offers, and the poll
        // below stays for cold starts).
        if (data.status === "ready") {
          setPhase("ready");
          signal("sandbox-ready");
          return;
        }
        setPhase("starting");
      } catch (err) {
        setPhase("error");
        setError(err instanceof Error ? err.message : String(err));
      }
    })();
  }, [agent, endUserId, signal]);

  // Elapsed counter, running only while something is actually pending.
  useEffect(() => {
    if (phase !== "starting" && phase !== "creating" && phase !== "reviving") return;
    const started = Date.now();
    const timer = setInterval(() => setElapsed(Math.round((Date.now() - started) / 1000)), 1000);
    return () => clearInterval(timer);
  }, [phase]);

  // 门户落点一次性取回：会话可能建好就 ready（池命中 / 预热句柄），就绪轮询根本
  // 不会跑，所以不能只靠轮询响应拿 portalHref。这里按 sessionId 单独取一次。
  useEffect(() => {
    if (!sessionId || portalHref) return;
    let stop = false;
    void (async () => {
      try {
        const res = await fetch(`/api/agenthub/session/${sessionId}`);
        const data = (await res.json()) as { portalHref?: string | null };
        if (!stop && data.portalHref) setPortalHref(data.portalHref);
      } catch {
        // 拿不到入口不影响会话本身。
      }
    })();
    return () => {
      stop = true;
    };
  }, [sessionId, portalHref]);

  // Readiness poll. Also the channel that reports Agent Recovery: a session that
  // idled out reports `pendingRevival` rather than `ready`, and the UI must say so
  // instead of spinning (the SDK refuses the turn outright in that window).
  useEffect(() => {
    if (!sessionId) return;
    if (phase !== "starting" && phase !== "reviving") return;
    let stop = false;

    const poll = async () => {
      try {
        const res = await fetch(`/api/agenthub/session/${sessionId}`);
        const data = (await res.json()) as {
          status?: string | null;
          pendingRevival?: unknown;
          failureReason?: string | null;
          portalHref?: string | null;
        };
        if (stop) return;
        // 门户落点拿到一次就留住，之后不覆盖成 null（服务端可能在配置空档回 null）。
        if (data.portalHref) setPortalHref(data.portalHref);
        if (data.pendingRevival) {
          setPhase("reviving");
          signal("revival");
          return;
        }
        if (data.status === "ready") {
          setPhase("ready");
          signal("sandbox-ready");
          return;
        }
        if (data.status === "failed" || data.failureReason) {
          setPhase("error");
          setPortalHref(null);
          setError(data.failureReason ?? "沙箱启动失败");
        }
      } catch {
        // transient — the next tick retries
      }
    };

    void poll();
    const timer = setInterval(poll, readyPollMs);
    return () => {
      stop = true;
      clearInterval(timer);
    };
  }, [sessionId, phase, signal, readyPollMs]);

  // ── SSE rendering feed ──────────────────────────────────────────────────────

  useEffect(() => {
    if (!sessionId || phase !== "ready") return;
    const source = new EventSource(`/api/agenthub/stream?sessionId=${encodeURIComponent(sessionId)}`);

    source.onmessage = (event) => {
      let frame: StreamFrame;
      try {
        frame = JSON.parse(event.data) as StreamFrame;
      } catch {
        return;
      }
      // A reconnect can replay; and chunks that arrive with no turn in flight are
      // history for turns already rendered from the authoritative response.
      if (frame.seq <= lastSeqRef.current) return;
      lastSeqRef.current = frame.seq;
      if (!pendingIdRef.current) return;

      const chunk = asStreamChunk(frame.chunk);
      if (!chunk) return;

      switch (chunk.type) {
        case "start":
          patchPending((m) => (m.stage ? m : { ...m, stage: "start" }));
          break;
        case "reasoning-start":
          patchPending((m) => ({ ...m, stage: "thinking" }));
          break;
        case "text-delta":
          signal("stream-chunk");
          patchPending((m) => ({ ...m, stage: "writing", text: m.text + chunk.delta }));
          break;
        case "reasoning-delta":
          signal("stream-chunk");
          patchPending((m) => ({ ...m, stage: "thinking", thinking: (m.thinking + chunk.delta).slice(-4000) }));
          break;
        case "tool-input-start": {
          const { label, kind, short } = describeTool(chunk.toolName);
          signal("tool-call", short);
          patchPending((m) => ({
            ...(m.trace.some((t) => t.id === chunk.toolCallId)
              ? m
              : { ...m, trace: [...m.trace, { id: chunk.toolCallId, label, kind, done: false }] }),
            stage: "tool",
            draft: { toolCallId: chunk.toolCallId, toolName: chunk.toolName },
            drafts: (m.drafts ?? []).some((d) => d.toolCallId === chunk.toolCallId)
              ? m.drafts
              : [...(m.drafts ?? []), { toolCallId: chunk.toolCallId, toolName: chunk.toolName }],
          }));
          break;
        }
        case "tool-input-available":
          patchPending((m) => ({
            ...m,
            stage: "tool",
            draft: { toolCallId: chunk.toolCallId, toolName: chunk.toolName, input: chunk.input },
            drafts: (m.drafts ?? []).some((d) => d.toolCallId === chunk.toolCallId)
              ? (m.drafts ?? []).map((d) => (d.toolCallId === chunk.toolCallId ? { ...d, input: chunk.input } : d))
              : [...(m.drafts ?? []), { toolCallId: chunk.toolCallId, toolName: chunk.toolName, input: chunk.input }],
          }));
          break;
        case "tool-output-available": {
          // Mode A: a `present_*` result IS the card envelope, so cards can render
          // mid-turn — before the model has written a single word of reply.
          const envelope = parseUiEnvelope(chunk.output);
          patchPending((m) => ({
            ...m,
            trace: m.trace.map((t) => (t.id === chunk.toolCallId ? { ...t, done: true } : t)),
            cards: envelope && !m.cards.some((c) => c.id === chunk.toolCallId)
              ? [...m.cards, ...cardsFromEnvelope(chunk.toolCallId, envelope)]
              : m.cards,
          }));
          if (envelope) signal("present-card", envelope.component);
          break;
        }
        default:
          break;
      }
    };

    source.addEventListener("stream-error", () => {
      // Upstream failed rather than the connection dropping. The authoritative
      // POST is still running, so this costs animation, not content — stay quiet.
      source.close();
    });

    return () => source.close();
  }, [sessionId, phase, patchPending, signal]);

  // ── sending ─────────────────────────────────────────────────────────────────

  const dispatch = useCallback(
    async (text: string, sid: string, { requeueOnRevival = true } = {}): Promise<AskOutcome> => {
      const agentMessageId = nextId();
      pendingIdRef.current = agentMessageId;
      setBusy(true);
      push({
        role: "agent",
        id: agentMessageId,
        text: "",
        cards: [],
        trace: [],
        thinking: "",
        streaming: true,
      });

      try {
        const res = await fetch("/api/agenthub/turn", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ agentHubSessionId: sid, text }),
        });
        const data = (await res.json()) as {
          status?: string;
          turnId?: string;
          replyText?: string;
          cards?: TurnCard[];
          toolCalls?: { id: string; name: string; shortName: string; failed: boolean }[];
          error?: string;
          detail?: string;
        };

        if (data.status === "revival_in_progress") {
          setMessages((prev) => prev.filter((m) => m.id !== agentMessageId));
          pendingIdRef.current = null;
          setPhase("reviving");
          signal("revival");
          if (!requeueOnRevival) {
            // `ask` 的调用方自己排回合：交回「正在恢复」，由它决定恢复后要不要重发。
            return { ok: false, code: "SESSION_REVIVING", error: "会话正在恢复" };
          }
          // The sandbox was reclaimed while idle. The turn was refused, not queued —
          // hold the text and resend once Agent Recovery reports ready.
          queuedRef.current = text;
          push({
            role: "system",
            id: nextId(),
            text: "会话闲置后被回收了，正在恢复沙箱，恢复完会自动把这句话发出去。",
          });
          return { ok: false, code: "SESSION_REVIVING", error: "会话正在恢复" };
        }

        // Authoritative rendering replaces whatever the stream drew.
        const trace: TraceItem[] = (data.toolCalls ?? []).map((t) => {
          const { label, kind } = describeTool(t.name);
          return { id: t.id, label, kind, done: true };
        });
        setMessages((prev) =>
          prev.map((m) =>
            m.id === agentMessageId && m.role === "agent"
              ? {
                  ...m,
                  text: data.replyText ?? m.text,
                  cards: data.cards ?? m.cards,
                  trace: trace.length > 0 ? trace : m.trace,
                  thinking: "",
                  drafts: undefined,
                  stage: undefined,
                  draft: undefined,
                  streaming: false,
                  failed: data.status !== "completed",
                  ...(data.turnId ? { turnId: data.turnId } : {}),
                }
              : m,
          ),
        );
        if ((data.cards ?? []).length > 0) signal("present-card");
        // Re-emit every tool this turn actually called. The stream may have missed
        // some (a reconnect, a chunk that arrived before the sheet opened); the
        // settled turn is the authority for what ran, and the capability panel is
        // only allowed to claim what ran.
        for (const call of data.toolCalls ?? []) signal("tool-call", describeTool(call.name).short);
        settledRef.current?.();
        return {
          ok: data.status === "completed",
          status: data.status,
          replyText: data.replyText,
          cards: data.cards ?? [],
          ...(res.ok ? {} : { code: data.error ?? `HTTP_${res.status}`, error: data.detail }),
        };
      } catch (err) {
        setMessages((prev) =>
          prev.map((m) =>
            m.id === agentMessageId && m.role === "agent"
              ? { ...m, streaming: false, failed: true, text: m.text || `请求失败：${String(err)}` }
              : m,
          ),
        );
        return { ok: false, code: "NETWORK_ERROR", error: String(err) };
      } finally {
        pendingIdRef.current = null;
        setBusy(false);
      }
    },
    [push, signal],
  );

  /**
   * 语音回合的后一半：等 agent 写完回复。`/api/agenthub/turn-result` 每次最多等 25 s，
   * 没到终态回 `pending` 就再问一次（不挂一条会被网关空闲超时掐断的长请求）。
   */
  const awaitTurnResult = useCallback(async (sid: string, turnId: string) => {
    const query = `sessionId=${encodeURIComponent(sid)}&turnId=${encodeURIComponent(turnId)}`;
    // 8 × 25 s ≈ 3 分钟：比任何一轮正常的点评都长得多，再长就当它卡住了。
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const res = await fetch(`/api/agenthub/turn-result?${query}`);
      const data = (await res.json().catch(() => ({}))) as {
        status?: string;
        transcript?: string;
        replyText?: string;
        cards?: TurnCard[];
        toolCalls?: { id: string; name: string; shortName: string; failed: boolean }[];
        error?: string;
      };
      if (!res.ok) return { ...data, status: "failed", error: data.error ?? `HTTP_${res.status}` };
      if (data.status !== "pending") return data;
    }
    return { status: "failed", error: "SESSION_TURN_WAIT_TIMEOUT" };
  }, []);

  /**
   * 语音回合：和 `dispatch` 同一套消息管道，只是发的是一个录音而不是文本，而且**分两段**
   * 交回：派发后转写先回（页面立刻画逐词比对），agent 的回复另外到（`reply`）。
   *
   * 几点和打字流不同：
   * - 用户消息里的文本**只有等平台转写完才知道**，所以占位的 agent 气泡先挂上（SSE 的
   *   逐字输出有地方落），转写回来后把 user 消息补进列表。顺序上它在 agent 气泡之后，
   *   不在之前——渲染面（英语课页）不按消息列表画，插在哪儿都不影响画面。
   * - 转写回来时**回合还在跑**（agent 在写点评）：`pendingIdRef` / `busy` 一直占到 `reply`
   *   落定，下一轮才能发——提前放开，下一轮会撞上平台的 `SESSION_TURN_IN_PROGRESS`。
   * - 失败**不**在页面上留一条失败的 agent 气泡：语音回合被拒时对话里什么都没有发生
   *   （平台连回合都没建），留个空壳只会让孩子以为老师回过了。占位气泡撤掉，提示交给卡片。
   */
  const dispatchVoice = useCallback(
    async (take: VoiceTake, sid: string): Promise<VoiceTurnOutcome> => {
      const agentMessageId = nextId();
      pendingIdRef.current = agentMessageId;
      setBusy(true);
      push({
        role: "agent",
        id: agentMessageId,
        text: "",
        cards: [],
        trace: [],
        thinking: "",
        streaming: true,
      });
      const release = () => {
        pendingIdRef.current = null;
        setBusy(false);
      };
      const drop = () => {
        setMessages((prev) => prev.filter((m) => m.id !== agentMessageId));
        release();
      };

      let data: {
        status?: string;
        turnId?: string;
        transcript?: string | null;
        error?: string;
        detail?: string;
      };
      let res: Response;
      try {
        const form = new FormData();
        form.append("sessionId", sid);
        // 文件名带扩展名——平台的语音门读的就是它（见 lib/agenthub/voice-recording.ts）。
        form.append("audio", take.blob, take.filename);
        res = await fetch("/api/agenthub/voice-turn", { method: "POST", body: form });
        data = (await res.json().catch(() => ({}))) as typeof data;
      } catch {
        drop();
        return { ok: false, code: "NETWORK_ERROR", error: voiceErrorMessage("NETWORK_ERROR") };
      }

      if (data.status === "revival_in_progress") {
        drop();
        setPhase("reviving");
        signal("revival");
        push({
          role: "system",
          id: nextId(),
          text: "会话闲置后被回收了，正在恢复沙箱——恢复好之后再按一下跟读按钮。",
        });
        return { ok: false, code: "SESSION_REVIVING", error: voiceErrorMessage("SESSION_REVIVING") };
      }

      if (!res.ok || !data.turnId) {
        drop();
        const code = typeof data.error === "string" ? data.error : `HTTP_${res.status}`;
        return { ok: false, code, error: voiceErrorMessage(code, data.detail) };
      }

      const turnId = data.turnId;
      const transcript = typeof data.transcript === "string" ? data.transcript.trim() : null;
      if (transcript !== null) push({ role: "user", id: nextId(), text: transcript || EMPTY_TRANSCRIPT_TEXT });
      signal(
        "voice-turn",
        transcript === null
          ? `回合 ${turnId.slice(0, 8)} · 转写稍后到`
          : `转写 ${transcript.split(/\s+/).filter(Boolean).length} 词 · 回合 ${turnId.slice(0, 8)}`,
      );

      const reply = (async (): Promise<VoiceReply> => {
        try {
          const result = await awaitTurnResult(sid, turnId);
          const trace: TraceItem[] = (result.toolCalls ?? []).map((t) => {
            const { label, kind } = describeTool(t.name);
            return { id: t.id, label, kind, done: true };
          });
          setMessages((prev) =>
            prev.map((m) =>
              m.id === agentMessageId && m.role === "agent"
                ? {
                    ...m,
                    text: result.replyText ?? m.text,
                    cards: result.cards ?? m.cards,
                    trace: trace.length > 0 ? trace : m.trace,
                    thinking: "",
                    drafts: undefined,
                    stage: undefined,
                    draft: undefined,
                    streaming: false,
                    failed: result.status !== "completed",
                    turnId,
                  }
                : m,
            ),
          );
          if (transcript === null && typeof result.transcript === "string") {
            push({ role: "user", id: nextId(), text: result.transcript.trim() || EMPTY_TRANSCRIPT_TEXT });
          }
          for (const call of result.toolCalls ?? []) signal("tool-call", describeTool(call.name).short);
          settledRef.current?.();
          return {
            ok: result.status === "completed",
            status: result.status,
            replyText: result.replyText,
            transcript: result.transcript,
            ...(result.error ? { code: result.error } : {}),
          };
        } catch {
          setMessages((prev) =>
            prev.map((m) => (m.id === agentMessageId && m.role === "agent" ? { ...m, streaming: false, failed: true } : m)),
          );
          return { ok: false, code: "NETWORK_ERROR" };
        } finally {
          release();
        }
      })();

      return { ok: true, turnId, transcript, reply };
    },
    [awaitTurnResult, push, signal],
  );

  const sendVoice = useCallback(
    async (take: VoiceTake): Promise<VoiceTurnOutcome> => {
      // 判在飞看 ref 不看 `busy`：调用方（英语课的回合队列）在上一轮落定的同一个 tick 里
      // 就会发下一轮，那时 `busy` 这个 state 还没重渲染过来。
      if (pendingIdRef.current) {
        return {
          ok: false,
          code: "SESSION_TURN_IN_PROGRESS",
          error: voiceErrorMessage("SESSION_TURN_IN_PROGRESS"),
        };
      }
      if (phase !== "ready" || !sessionId) {
        return { ok: false, code: "SESSION_NOT_READY", error: voiceErrorMessage("SESSION_NOT_READY") };
      }
      return dispatchVoice(take, sessionId);
    },
    [dispatchVoice, phase, sessionId],
  );

  const ask = useCallback(
    async (text: string): Promise<AskOutcome> => {
      const trimmed = text.trim();
      if (!trimmed) return { ok: false, code: "bad_request", error: "空消息" };
      if (pendingIdRef.current) {
        return { ok: false, code: "SESSION_TURN_IN_PROGRESS", error: "上一轮还没结束" };
      }
      if (phase !== "ready" || !sessionId) return { ok: false, code: "SESSION_NOT_READY", error: "会话还没就绪" };
      push({ role: "user", id: nextId(), text: trimmed });
      return dispatch(trimmed, sessionId, { requeueOnRevival: false });
    },
    [dispatch, phase, push, sessionId],
  );

  const send = useCallback(
    (text: string) => {
      const trimmed = text.trim();
      if (!trimmed || busy) return;
      push({ role: "user", id: nextId(), text: trimmed });
      if (!startedRef.current) start();
      if (phase === "ready" && sessionId) {
        void dispatch(trimmed, sessionId);
      } else {
        // Typed before the sandbox finished starting: hold it, don't refuse it.
        queuedRef.current = trimmed;
        setBusy(true);
      }
    },
    [busy, dispatch, phase, push, sessionId, start],
  );

  // Drain whatever was typed (or refused during revival) once the session is ready.
  useEffect(() => {
    if (phase !== "ready" || !sessionId) return;
    const queued = queuedRef.current;
    if (!queued) return;
    queuedRef.current = null;
    void dispatch(queued, sessionId);
  }, [phase, sessionId, dispatch]);

  return { phase, sessionId, portalHref, userId, messages, busy, elapsed, error, start, send, ask, sendVoice };
}
