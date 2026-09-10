"use client";

/**
 * 对话引擎，各个 case 的手机 App 共用。三个真相来源分开：
 *
 * - SSE 只管「跑的时候看到什么」——工具轨迹、卡片、逐字正文，不带生命周期语义。
 * - `POST /api/agenthub/turn`（服务端 await waitForTurn）是权威，返回后整体替换
 *   流式画的内容，所以掉线最多损失动画。
 * - `GET /api/agenthub/session/<id>` 只管就绪。沙箱启动期间输入框可用，就绪后
 *   自动发出——让人对着禁用的输入框等 20 秒不是安全性，是糟糕的第一印象。
 */

import { useCallback, useEffect, useRef, useState } from "react";
import type { AgentKey } from "@/lib/agenthub/client";
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
      streaming: boolean;
      failed?: boolean;
    };

export type SessionPhase =
  | "idle" // nothing started yet
  | "creating"
  | "starting" // sandbox booting
  | "ready"
  | "reviving" // idle-reclaimed, Agent Recovery in flight
  | "unconfigured"
  | "error";

export interface Conversation {
  phase: SessionPhase;
  sessionId: string | null;
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
}

let idSeq = 0;
const nextId = () => `m${++idSeq}`;

export function useAgentConversation({ agent, endUserId, onSignal, onSettled }: Options): Conversation {
  const [phase, setPhase] = useState<SessionPhase>("idle");
  const [sessionId, setSessionId] = useState<string | null>(null);
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
        };
        if (stop) return;
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
          setError(data.failureReason ?? "沙箱启动失败");
        }
      } catch {
        // transient — the next tick retries
      }
    };

    void poll();
    const timer = setInterval(poll, 1500);
    return () => {
      stop = true;
      clearInterval(timer);
    };
  }, [sessionId, phase, signal]);

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
        case "text-delta":
          signal("stream-chunk");
          patchPending((m) => ({ ...m, text: m.text + chunk.delta }));
          break;
        case "reasoning-delta":
          signal("stream-chunk");
          patchPending((m) => ({ ...m, thinking: (m.thinking + chunk.delta).slice(-4000) }));
          break;
        case "tool-input-start": {
          const { label, kind, short } = describeTool(chunk.toolName);
          signal("tool-call", short);
          patchPending((m) =>
            m.trace.some((t) => t.id === chunk.toolCallId)
              ? m
              : { ...m, trace: [...m.trace, { id: chunk.toolCallId, label, kind, done: false }] },
          );
          break;
        }
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
    async (text: string, sid: string) => {
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
          replyText?: string;
          cards?: TurnCard[];
          toolCalls?: { id: string; name: string; shortName: string; failed: boolean }[];
          detail?: string;
        };

        if (data.status === "revival_in_progress") {
          // The sandbox was reclaimed while idle. The turn was refused, not queued —
          // hold the text and resend once Agent Recovery reports ready.
          setMessages((prev) => prev.filter((m) => m.id !== agentMessageId));
          pendingIdRef.current = null;
          queuedRef.current = text;
          setPhase("reviving");
          signal("revival");
          push({
            role: "system",
            id: nextId(),
            text: "会话闲置后被回收了，正在恢复沙箱 —— 恢复完会自动把这句话发出去。",
          });
          return;
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
                  streaming: false,
                  failed: data.status !== "completed",
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
      } catch (err) {
        setMessages((prev) =>
          prev.map((m) =>
            m.id === agentMessageId && m.role === "agent"
              ? { ...m, streaming: false, failed: true, text: m.text || `请求失败：${String(err)}` }
              : m,
          ),
        );
      } finally {
        pendingIdRef.current = null;
        setBusy(false);
      }
    },
    [push, signal],
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

  return { phase, sessionId, userId, messages, busy, elapsed, error, start, send };
}
