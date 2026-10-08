"use client";

/**
 * 英语小课和 agent 之间的「单通道」：所有要找 agent 的事都在这里排队，同一时刻只跑一个回合。
 * 排谁先、丢谁，规则在
 * `lib/course/turn-queue.ts`；这里负责跑、把结果放进页面读得到的状态里。
 *
 * 四种活：
 * - `lesson`：【出题】出一关（W1）。会话一就绪就预出当前那一关；孩子点开一关还没出好时，
 *   这件事提成 urgent。
 * - `review`：【结算】一句点评 + 出下一关（W4）。点评流进结算屏，下一关进 `lessons`。
 * - `explain`：【为什么】讲一题（W2）。答错时后台先要上，孩子点了才显示。
 * - `voice`：跟读的语音回合（W3）。转写一回来就交给题目画比对，agent 的文字点评后到。
 *
 * 讲解 / 点评「点了才显示、没好就 loading、在写就逐字流入」：逐字内容来自会话的 SSE
 * （`useAgentConversation` 订阅的 `sessions.streamEvents`，经 `/api/agenthub/stream`），
 * 正在跑的那一件的流式正文和阶段（准备 / 在想 / 在写题）由 `live` 交出去。
 *
 * 出题也看流：分两批出的一关，第一批 `present_lesson` 的入参一到（`tool-input-available`）
 * 就把这一关标成能开、孩子开始答，不等整轮结束；回合终态时用权威结果收尾。
 * 流里的草稿按 toolCallId 全记：两批并行发出、一次被拒后重调，都能按批次号拼对；
 * 回合还在跑时只拼从第 1 批起连续的几批，且不算「到齐」——到齐只认回合终态。
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Conversation } from "@/components/agent/useAgentConversation";
import type { VoiceTake } from "@/lib/agenthub/voice-recording";
import {
  lessonFromCards,
  lessonRequestMessage,
  liveLessonCards,
  reviewText,
  settleLessonContent,
  stampLesson,
  type LessonContent,
} from "@/lib/course/english-lesson";
import { stopById, stopLabel } from "@/lib/course/english-path";
import { demote, isStale, promote, takeNext, type QueuedJob } from "@/lib/course/turn-queue";

export type LessonSlot =
  /** 能开了（`content.complete` 为 false 时后面的批次还在路上）。`readyMs` = 从派发到能开。 */
  | { status: "ready"; content: LessonContent; readyMs: number }
  | { status: "failed"; error: string };

export type LessonStatus = "ready" | "running" | "queued" | "failed" | "none";

/** 讲解 / 点评 / 结算点评的一条结果。 */
export interface Reply {
  status: "queued" | "running" | "done" | "failed" | "dropped";
  text: string;
}

/** 一次跟读在通道里走到哪了。 */
export interface VoiceState {
  status: "queued" | "sending" | "done" | "failed";
  transcript?: string;
  error?: string;
  /** 从交出录音到拿到转写，页面这一侧量到的毫秒数（W3 的读数）。 */
  transcriptMs?: number;
}

type Job = QueuedJob &
  (
    | { kind: "lesson"; levelId: string; lessonId: string }
    | { kind: "review"; key: string; message: string; nextLevelId: string | null; nextLessonId: string | null }
    | { kind: "explain"; key: string; message: string }
    | { kind: "voice"; key: string; take: VoiceTake; feedbackKey: string; enqueuedAt: number }
  );

/** 正在跑的那一件，流式看得到的东西。 */
export interface LiveTurn {
  kind: Job["kind"];
  /** 这一件的结果落在 `replies` 的哪个键上（讲解、跟读点评、结算点评）。 */
  replyKey: string | null;
  /** 这一件会出哪一关的题（出题、结算点评带的下一关）。 */
  levelId: string | null;
  text: string;
  /** 流到哪个阶段：等平台开跑 / 在准备 / 在想 / 在写正文 / 在写题。 */
  stage: "waiting" | "start" | "thinking" | "writing" | "tool";
}

function mark(name: string, detail: string) {
  if (typeof window === "undefined") return;
  // 页面计时：读数从浏览器取（DevTools 控制台，或 performance.getEntriesByType("mark")）。
  try {
    performance.mark(`en:${name}`, { detail });
  } catch {
    // 老浏览器不支持带 detail 的 mark，读数还在 console 里
  }
  console.info(`[english-course] ${name} ${detail}`);
}

export function useLessonChannel(conversation: Conversation) {
  const conversationRef = useRef(conversation);
  conversationRef.current = conversation;

  const queueRef = useRef<Job[]>([]);
  const runningRef = useRef<Job | null>(null);
  const stepRef = useRef(0);
  const seqRef = useRef(0);
  const [queue, setQueue] = useState<Job[]>([]);
  const [running, setRunning] = useState<Job | null>(null);
  const [lessons, setLessons] = useState<Record<string, LessonSlot>>({});
  const lessonsRef = useRef(lessons);
  lessonsRef.current = lessons;
  const [replies, setReplies] = useState<Record<string, Reply>>({});
  const [voices, setVoices] = useState<Record<string, VoiceState>>({});

  const sync = () => setQueue([...queueRef.current]);
  const setReply = (key: string, reply: Reply) => setReplies((prev) => ({ ...prev, [key]: reply }));

  const newJob = <K extends Job["kind"]>(kind: K, urgent: boolean): QueuedJob & { kind: K } => {
    seqRef.current += 1;
    return { id: `j${seqRef.current}`, kind, step: stepRef.current, urgent, urgentAt: urgent ? Date.now() : 0, seq: seqRef.current };
  };

  // pump 要在 run 里递归调用，用 ref 绕开 useCallback 的循环依赖。
  const pumpRef = useRef<() => void>(() => {});

  const enqueue = useCallback((job: Job) => {
    queueRef.current = [...queueRef.current, job];
    if (job.kind === "explain" || job.kind === "review") setReply(job.key, { status: "queued", text: "" });
    if (job.kind === "voice") setVoices((prev) => ({ ...prev, [job.key]: { status: "queued" } }));
    sync();
    pumpRef.current();
  }, []);

  const enqueueLesson = useCallback(
    (levelId: string, urgent: boolean) => {
      const job = newJob("lesson", urgent);
      enqueue({ ...job, levelId, lessonId: `${levelId}#${job.seq}` });
    },
    [enqueue],
  );
  const runStartedRef = useRef(0);

  /**
   * 一轮出题的回合到终态了：用权威结果定下这一关（规则在 `settleLessonContent`：盖上页面
   * 自己的编号、比已经交给播放器的短时不缩短、回合结束即「到齐」）。分批声明了两批、回合
   * 却只出了一批，第二批不会再来了，页面上答完第一批就进再练一次 / 结算。
   */
  const settleLesson = useCallback(
    (levelId: string, lessonId: string, cards: Parameters<typeof lessonFromCards>[0], startedAt: number, error?: string) => {
      const found = lessonFromCards(cards);
      const totalMs = Date.now() - startedAt;
      mark("w1-lesson-done", `${levelId} ${totalMs}ms ${found ? `${found.exercises.length} 题（${found.source}）` : "没出成"}`);
      setLessons((prev) => {
        const before = prev[levelId];
        const content = settleLessonContent(before?.status === "ready" ? before.content : null, found, lessonId);
        if (!content) {
          // 这一轮没出成：槽位里还有别的一关（比如之前出好的）就留着，没有才记失败。
          if (before?.status === "ready") return prev;
          return { ...prev, [levelId]: { status: "failed", error: error ?? "老师这次没把题出成" } };
        }
        const readyMs = before?.status === "ready" && before.content.lessonId === lessonId ? before.readyMs : totalMs;
        return { ...prev, [levelId]: { status: "ready", content, readyMs } };
      });
    },
    [],
  );

  const run = useCallback(
    async (job: Job) => {
      const conversation = conversationRef.current;
      const startedAt = Date.now();
      runStartedRef.current = startedAt;
      switch (job.kind) {
        case "lesson": {
          const stop = stopById(job.levelId);
          if (!stop) return;
          const outcome = await conversation.ask(
            lessonRequestMessage({ label: stopLabel(stop), goal: stop.level.goal, lessonId: job.lessonId }),
          );
          if (outcome.code === "SESSION_REVIVING") {
            // 会话被回收、正在恢复：这件事原样放回队首，恢复好了再出。
            queueRef.current = [{ ...job, urgent: true, urgentAt: 0 }, ...queueRef.current];
            sync();
            return;
          }
          settleLesson(job.levelId, job.lessonId, outcome.cards ?? [], startedAt, outcome.error ?? outcome.code);
          return;
        }
        case "review": {
          setReply(job.key, { status: "running", text: "" });
          const outcome = await conversation.ask(job.message);
          // 点评框只放点评那一段（调工具之前写的），工具之后补的话不进。
          const review = reviewText(outcome.replyText);
          setReply(job.key, { status: outcome.ok || review ? "done" : "failed", text: review });
          if (!job.nextLevelId) return;
          const content = lessonFromCards(outcome.cards ?? []);
          mark("w4-review", `${job.nextLevelId} ${Date.now() - startedAt}ms ${content ? `下一关 ${content.exercises.length} 题` : "没带下一关"}`);
          if (content && job.nextLessonId) {
            settleLesson(job.nextLevelId, job.nextLessonId, outcome.cards ?? [], startedAt);
          } else if (lessonsRef.current[job.nextLevelId]?.status !== "ready") {
            // 点评回了、下一关没出：单独补一次出题，后台排着。
            enqueueLesson(job.nextLevelId, false);
          }
          return;
        }
        case "explain": {
          setReply(job.key, { status: "running", text: "" });
          const outcome = await conversation.ask(job.message);
          // 讲解回合只要正文：CLAUDE.md 让它不调工具，万一调了也不画。
          setReply(job.key, {
            status: outcome.replyText ? "done" : "failed",
            text: outcome.replyText ?? "",
          });
          return;
        }
        case "voice": {
          setVoices((prev) => ({ ...prev, [job.key]: { status: "sending" } }));
          const outcome = await conversation.sendVoice(job.take);
          const transcriptMs = Date.now() - job.enqueuedAt;
          if (!outcome.ok) {
            setVoices((prev) => ({ ...prev, [job.key]: { status: "failed", error: outcome.error } }));
            return;
          }
          if (typeof outcome.transcript === "string") {
            mark("w3-transcript", `${transcriptMs}ms（含排队 ${startedAt - job.enqueuedAt}ms）`);
            setVoices((prev) => ({ ...prev, [job.key]: { status: "done", transcript: outcome.transcript as string, transcriptMs } }));
          }
          setReply(job.feedbackKey, { status: "running", text: "" });
          const reply = outcome.reply ? await outcome.reply : { ok: false };
          if (typeof outcome.transcript !== "string") {
            // 派发那一跳没读到转写，回合结束时从回合上补。
            setVoices((prev) => ({
              ...prev,
              [job.key]: { status: "done", transcript: reply.transcript ?? "", transcriptMs: Date.now() - job.enqueuedAt },
            }));
          }
          setReply(job.feedbackKey, {
            status: reply.replyText ? "done" : "failed",
            text: reply.replyText ?? "",
          });
          return;
        }
      }
    },
    [enqueueLesson, settleLesson],
  );

  const pump = useCallback(() => {
    if (runningRef.current) return;
    if (conversationRef.current.phase !== "ready") return;
    const { next, rest, dropped } = takeNext(queueRef.current, stepRef.current);
    for (const job of dropped) {
      if (job.kind === "explain") setReply(job.key, { status: "dropped", text: "" });
    }
    queueRef.current = rest;
    sync();
    if (!next) return;
    runningRef.current = next;
    setRunning(next);
    void run(next)
      .catch((err: unknown) => {
        console.warn("[english-course] turn failed", err);
        if (next.kind === "explain" || next.kind === "review") setReply(next.key, { status: "failed", text: "" });
        if (next.kind === "lesson") {
          setLessons((prev) => ({ ...prev, [next.levelId]: { status: "failed", error: String(err) } }));
        }
        if (next.kind === "voice") setVoices((prev) => ({ ...prev, [next.key]: { status: "failed", error: String(err) } }));
      })
      .finally(() => {
        runningRef.current = null;
        setRunning(null);
        pumpRef.current();
      });
  }, [run]);
  pumpRef.current = pump;

  // 会话就绪（或者恢复好了）就开始跑排着的活。
  useEffect(() => {
    if (conversation.phase === "ready") pump();
  }, [conversation.phase, pump]);

  // ── 页面调用的入口 ────────────────────────────────────────────────────────

  const lessonStatus = useCallback(
    (levelId: string): LessonStatus => {
      if (lessons[levelId]?.status === "ready") return "ready";
      const provides = (job: Job) =>
        (job.kind === "lesson" && job.levelId === levelId) || (job.kind === "review" && job.nextLevelId === levelId);
      if (running && provides(running)) return "running";
      if (queue.some(provides)) return "queued";
      if (lessons[levelId]?.status === "failed") return "failed";
      return "none";
    },
    [lessons, queue, running],
  );

  /**
   * 编号为 `lessonId` 的这一关还有没有活在给它出题（在跑或在排队）。没有了，就不会再有
   * 批次来——播放器据此把手上这一关按「到齐」收尾。
   */
  const isSupplying = useCallback(
    (lessonId: string | undefined): boolean => {
      if (!lessonId) return false;
      const supplies = (job: Job) =>
        (job.kind === "lesson" && job.lessonId === lessonId) || (job.kind === "review" && job.nextLessonId === lessonId);
      return Boolean((running && supplies(running)) || queue.some(supplies));
    },
    [queue, running],
  );

  /** 孩子点开了一关：没出好就让它插队；没排上就排一个 urgent 的。 */
  const requestLesson = useCallback(
    (levelId: string, { urgent }: { urgent: boolean }) => {
      if (lessonsRef.current[levelId]?.status === "ready") return;
      const provides = (job: Job) =>
        (job.kind === "lesson" && job.levelId === levelId) || (job.kind === "review" && job.nextLevelId === levelId);
      if (runningRef.current && provides(runningRef.current)) return;
      const queued = queueRef.current.find(provides);
      if (queued) {
        if (urgent) {
          queueRef.current = promote(queueRef.current, queued.id, Date.now());
          sync();
          pumpRef.current();
        }
        return;
      }
      setLessons((prev) => {
        const { [levelId]: _failed, ...rest } = prev;
        return rest;
      });
      enqueueLesson(levelId, urgent);
    },
    [enqueueLesson],
  );

  /** 给结算点评里「下一关」起一个 lesson_id（agent 原样抄进 present_lesson）。 */
  const newLessonId = useCallback((levelId: string) => {
    seqRef.current += 1;
    return `${levelId}#${seqRef.current}`;
  }, []);

  const requestReview = useCallback(
    (key: string, message: string, next: { levelId: string; lessonId: string } | null) => {
      enqueue({
        ...newJob("review", false),
        key,
        message,
        nextLevelId: next?.levelId ?? null,
        nextLessonId: next?.lessonId ?? null,
      });
    },
    [enqueue],
  );

  /** 答错了：后台先把讲解要上（不点不显示）。 */
  const prepareExplain = useCallback(
    (key: string, message: string) => {
      const existing = replies[key];
      if (existing && existing.status !== "dropped" && existing.status !== "failed") return;
      enqueue({ ...newJob("explain", false), key, message });
    },
    [enqueue, replies],
  );

  /** 孩子点了「为什么」：好了就直接看；排着的插到最前；丢了 / 失败了就重新要一次（urgent）。 */
  const openExplain = useCallback(
    (key: string, message: string) => {
      const job = queueRef.current.find((j) => j.kind === "explain" && j.key === key);
      if (job) {
        queueRef.current = promote(queueRef.current, job.id, Date.now());
        sync();
        pumpRef.current();
        return;
      }
      const status = replies[key]?.status;
      if (status === "running" || status === "done") return;
      enqueue({ ...newJob("explain", true), key, message });
    },
    [enqueue, replies],
  );

  /** 孩子点了「继续」离开这道题：它的讲解不再算点过；步数 +1，过期的后台讲解随之丢掉。 */
  const leaveQuestion = useCallback((explainKey: string | null, steps = 1) => {
    if (explainKey) {
      const job = queueRef.current.find((j) => j.kind === "explain" && j.key === explainKey);
      if (job) queueRef.current = demote(queueRef.current, job.id);
    }
    stepRef.current += steps;
    // 过期的就地标成 dropped（不等下一次 pump，孩子回看时状态是对的）。
    const dropped = queueRef.current.filter((job) => isStale(job, stepRef.current));
    if (dropped.length > 0) {
      queueRef.current = queueRef.current.filter((job) => !isStale(job, stepRef.current));
      for (const job of dropped) if (job.kind === "explain") setReply(job.key, { status: "dropped", text: "" });
    }
    sync();
    pumpRef.current();
  }, []);

  const sendVoice = useCallback(
    (key: string, feedbackKey: string, take: VoiceTake) => {
      enqueue({ ...newJob("voice", true), key, take, feedbackKey, enqueuedAt: Date.now() });
    },
    [enqueue],
  );

  // ── 正在跑的那一件：流式看得到的东西 ────────────────────────────────────────

  const pending = useMemo(() => {
    if (!running) return null;
    const last = [...conversation.messages].reverse().find((m) => m.role === "agent");
    return last && last.role === "agent" && last.streaming ? last : null;
  }, [conversation.messages, running]);

  // 出题的回合还在跑，流里已经有 present_lesson 了（入参到了，或者结果回来了）：这一关
  // 先标成能开。分批出的第一批就是这么让孩子提前开答的。
  useEffect(() => {
    if (!running || !pending) return;
    const levelId = running.kind === "lesson" ? running.levelId : running.kind === "review" ? running.nextLevelId : null;
    const lessonId = running.kind === "lesson" ? running.lessonId : running.kind === "review" ? running.nextLessonId : null;
    if (!levelId || !lessonId) return;
    // 回合还在跑：只拼从第 1 批起连续的批次，且一律不算齐（草稿可能被拒）——到齐只认回合终态的
    // settleLesson。盖上页面自己的编号。
    const found = lessonFromCards(liveLessonCards(pending.cards, pending.drafts ?? []), { live: true });
    if (!found) return;
    const content = stampLesson(found, lessonId);
    const before = lessonsRef.current[levelId];
    const sameLesson = before?.status === "ready" && before.content.lessonId === lessonId;
    // 同一关只增不减（草稿画出的题已经交给播放器了）。
    if (sameLesson && before.content.exercises.length >= content.exercises.length) return;
    const readyMs = sameLesson ? before.readyMs : Date.now() - runStartedRef.current;
    if (!sameLesson) {
      mark("w1-first-batch", `${levelId} ${readyMs}ms ${content.exercises.length} 题${content.complete ? "（整关）" : "（后面还有）"}`);
    }
    setLessons((prev) => ({ ...prev, [levelId]: { status: "ready", content, readyMs } }));
  }, [pending, running]);

  // 结算点评流进来时只显示调工具之前那一段：流里的正文是各段直接接起来的，工具之后补的话
  // 会接在点评后面。第一次看到工具调用时记下正文长度，之后只显示到这里。
  const reviewCutRef = useRef<{ jobId: string; at: number } | null>(null);
  const live = useMemo<LiveTurn | null>(() => {
    if (!running) return null;
    let text = pending?.text ?? "";
    if (running.kind === "review" && pending) {
      const cut = reviewCutRef.current;
      if (cut?.jobId !== running.id && (pending.stage === "tool" || (pending.drafts?.length ?? 0) > 0)) {
        reviewCutRef.current = { jobId: running.id, at: text.length };
      }
      if (reviewCutRef.current?.jobId === running.id) text = text.slice(0, reviewCutRef.current.at);
    }
    return {
      kind: running.kind,
      replyKey:
        running.kind === "voice" ? running.feedbackKey : running.kind === "lesson" ? null : running.key,
      levelId: running.kind === "lesson" ? running.levelId : running.kind === "review" ? running.nextLevelId : null,
      text,
      stage: pending?.stage ?? "waiting",
    };
  }, [pending, running]);

  return {
    lessons,
    replies,
    voices,
    live,
    running: running ? { kind: running.kind, id: running.id } : null,
    lessonStatus,
    isSupplying,
    requestLesson,
    newLessonId,
    requestReview,
    prepareExplain,
    openExplain,
    leaveQuestion,
    sendVoice,
  };
}

export type LessonChannel = ReturnType<typeof useLessonChannel>;
