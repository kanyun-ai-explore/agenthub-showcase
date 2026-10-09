"use client";

/**
 * 英语小课和 agent 之间的「单通道」：所有要找 agent 的事都在这里排队，同一时刻只跑一个回合。
 * 排谁先、丢谁，规则在
 * `lib/course/turn-queue.ts`；这里负责跑、把结果放进页面读得到的状态里。
 *
 * 四种活（课程 v2：单元 1、2 的题写死在前端，不经这里）：
 * - `lesson`：【出题】后台出单元 3 的一关。消息由页面拼（带最新的错题），学员点开一关还没出好时
 *   这件事提成 urgent。出来的一关缺听音或跟读（`meetsVoiceRequirement`）就当没出成，自动重出一次。
 * - `review`：【单元结算】一个单元做完，一句点评流进结算屏。
 * - `explain`：【为什么】讲一题（W2）。答错时后台先要上，学员点了才显示。
 * - `voice`：跟读的语音回合（W3）。转写一回来就交给题目画比对，agent 的文字点评后到。
 *
 * 讲解 / 点评「点了才显示、没好就 loading、在写就逐字流入」：逐字内容来自会话的 SSE
 * （`useAgentConversation` 订阅的 `sessions.streamEvents`，经 `/api/agenthub/stream`），
 * 正在跑的那一件的流式正文和阶段（准备 / 在想 / 在写题）由 `live` 交出去。
 *
 * 出题也看流：`present_lesson` 的入参一到（`tool-input-available`）就把这一关标成能开——学员
 * 正在等这一关时不必等整轮结束；回合终态时用权威结果收尾。
 * 流里的草稿按 toolCallId 全记：两批并行发出、一次被拒后重调，都能按批次号拼对；
 * 回合还在跑时只拼从第 1 批起连续的几批，且不算「到齐」——到齐只认回合终态。
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Conversation } from "@/components/agent/useAgentConversation";
import type { VoiceTake } from "@/lib/agenthub/voice-recording";
import {
  lessonFromCards,
  liveLessonCards,
  meetsVoiceRequirement,
  reviewText,
  settleLessonContent,
  stampLesson,
  type LessonContent,
} from "@/lib/course/english-lesson";
import {
  abandonsBackground,
  demote,
  drainQueue,
  dropVoice,
  isStale,
  laneOf,
  promote,
  takeNext,
  type Lane,
  type QueuedJob,
} from "@/lib/course/turn-queue";

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

/** 给定页面编号拼【出题】消息（错题由页面在入队那一刻取，重出时编号换新、错题不变）。 */
export type ComposeLesson = (lessonId: string) => string;

/** 一关出来缺听音或跟读、或者干脆没出成，自动重出几次（含第一次）。 */
const LESSON_ATTEMPTS = 2;

type Job = QueuedJob &
  (
    | { kind: "lesson"; levelId: string; lessonId: string; compose: ComposeLesson; attempt: number }
    | { kind: "review"; key: string; message: string }
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

/**
 * `background`：英语小课的第二个 coach 会话，专跑单元 3 的后台出题。
 * 两条道：出题走 `background`，讲解、跟读、单元点评走主会话，互不排队（`laneOf`）。第二个会话等第一件
 * 出题活来了才建（懒建）；它建不起来或者中途变成 error / unconfigured，就记下「不可用」，排着的和以后的
 * 出题活全部回落到主会话，和改之前一样排队——页面照常可用。不传 `background` 就是单会话。
 */
export function useLessonChannel(conversation: Conversation, background: Conversation | null = null) {
  const conversationRef = useRef(conversation);
  conversationRef.current = conversation;
  const backgroundRef = useRef(background);
  backgroundRef.current = background;
  /** 第二个会话不可用了（建不起来、中途出错）：出题活回落到主会话。 */
  const backgroundFailedRef = useRef(false);
  const backgroundUsable = () => Boolean(backgroundRef.current) && !backgroundFailedRef.current;
  const conversationOf = (lane: Lane): Conversation | null => (lane === "main" ? conversationRef.current : backgroundRef.current);

  const queueRef = useRef<Job[]>([]);
  const runningRef = useRef<Record<Lane, Job | null>>({ main: null, background: null });
  const stepRef = useRef(0);
  const seqRef = useRef(0);
  const [queue, setQueue] = useState<Job[]>([]);
  const [runningByLane, setRunningByLane] = useState<Record<Lane, Job | null>>({ main: null, background: null });
  const running = runningByLane.main;
  const runningBackground = runningByLane.background;
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
    (levelId: string, urgent: boolean, compose: ComposeLesson, attempt = 1) => {
      const job = newJob("lesson", urgent);
      // 页面编号带上时刻：单元 3 的题存在本机，刷新后序号从头数，只用序号会和存下的那一版撞号。
      enqueue({ ...job, levelId, lessonId: `${levelId}#${Date.now().toString(36)}${job.seq}`, compose, attempt });
    },
    [enqueue],
  );
  const runStartedRef = useRef<Record<Lane, number>>({ main: 0, background: 0 });

  /**
   * 一轮出题的回合到终态了：用权威结果定下这一关（规则在 `settleLessonContent`：盖上页面
   * 自己的编号、比已经交给播放器的短时不缩短、回合结束即「到齐」）。分批声明了两批、回合
   * 却只出了一批，第二批不会再来了，页面上答完第一批就进再练一次 / 结算。
   */
  const settleLesson = useCallback(
    (
      levelId: string,
      lessonId: string,
      cards: Parameters<typeof lessonFromCards>[0],
      startedAt: number,
      { error, final, origin }: { error?: string; final: boolean; origin?: LessonContent["origin"] },
    ): boolean => {
      const raw = lessonFromCards(cards);
      // 缺听音或跟读的一关不收（硬要求：每一关都用到 TTS 和 ASR）。
      const found = raw && meetsVoiceRequirement(raw) ? raw : null;
      const totalMs = Date.now() - startedAt;
      mark(
        "w1-lesson-done",
        `${levelId} ${totalMs}ms ${raw ? `${raw.exercises.length} 题（${raw.source}）${found ? "" : "，缺听音或跟读，不收"}` : "没出成"}`,
      );
      const before = lessonsRef.current[levelId];
      const settled = settleLessonContent(before?.status === "ready" ? before.content : null, found, lessonId);
      // 记下这一关是哪一轮出的：取读音时服务端从这一轮里取文字。
      const content = settled && origin ? { ...settled, origin } : settled;
      if (!content) {
        // 这一轮没出成：槽位里还有别的一关（比如之前出好的）就留着；没有、而且不会再重出了才记失败。
        if (before?.status !== "ready" && final) {
          setLessons((prev) => ({
            ...prev,
            [levelId]: { status: "failed", error: error ?? (raw ? "出的题缺听音或跟读" : "老师这次没把题出成") },
          }));
        }
        return false;
      }
      const readyMs = before?.status === "ready" && before.content.lessonId === lessonId ? before.readyMs : totalMs;
      setLessons((prev) => ({ ...prev, [levelId]: { status: "ready", content, readyMs } }));
      return true;
    },
    [],
  );

  const run = useCallback(
    async (job: Job, lane: Lane) => {
      const conversation = conversationOf(lane) ?? conversationRef.current;
      const startedAt = Date.now();
      runStartedRef.current[lane] = startedAt;
      switch (job.kind) {
        case "lesson": {
          const outcome = await conversation.ask(job.compose(job.lessonId));
          if (outcome.code === "SESSION_REVIVING" || outcome.code === "SESSION_REBUILDING") {
            // 会话被回收、正在恢复，或者归属 cookie 没了、正在换新会话：这件事原样放回队首，会话好了再出。
            queueRef.current = [{ ...job, urgent: true, urgentAt: 0 }, ...queueRef.current];
            sync();
            return;
          }
          if (abandonsBackground(lane, outcome)) {
            // 第二个会话就绪以后回合跑不完：记成不可用，这件活原样改走主会话（不算一次重出），以后的出题也都走主会话。
            backgroundFailedRef.current = true;
            mark("bg-fallback", `第二个会话上的出题回合没跑完（${outcome.code ?? outcome.status ?? "未知"}），出题回到主会话`);
            queueRef.current = [...queueRef.current, job];
            sync();
            return;
          }
          const final = job.attempt >= LESSON_ATTEMPTS;
          const ok = settleLesson(job.levelId, job.lessonId, outcome.cards ?? [], startedAt, {
            error: outcome.error ?? outcome.code,
            final,
            origin:
              conversation.sessionId && outcome.turnId ? { sessionId: conversation.sessionId, turnId: outcome.turnId } : undefined,
          });
          // 没出成或缺听音 / 跟读：换个编号再出一次，紧急程度照旧。
          if (!ok && !final) enqueueLesson(job.levelId, job.urgent, job.compose, job.attempt + 1);
          return;
        }
        case "review": {
          setReply(job.key, { status: "running", text: "" });
          const outcome = await conversation.ask(job.message);
          // 点评框只放第一段，后面补的话不进。
          const review = reviewText(outcome.replyText);
          mark("w4-review", `${Date.now() - startedAt}ms`);
          setReply(job.key, { status: outcome.ok || review ? "done" : "failed", text: review });
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

  /** 每条道各跑各的：道上没有在跑的、这条道的会话就绪，就从这条道的活里挑下一个。 */
  const pump = useCallback(() => {
    for (const lane of ["main", "background"] as const) {
      if (runningRef.current[lane]) continue;
      const conv = conversationOf(lane);
      if (!conv) continue;
      const usable = backgroundUsable();
      const mine = queueRef.current.filter((job) => laneOf(job, usable) === lane);
      if (mine.length === 0) continue;
      // 第二个会话懒建：第一件出题活来了才建，建好了（phase 变 ready）由下面的 effect 再推一次。
      if (lane === "background" && conv.phase === "idle") {
        mark("bg-session", "第一件后台出题活来了，建第二个会话");
        conv.start();
        continue;
      }
      if (conv.phase !== "ready") continue;
      const { next, rest, dropped } = takeNext(mine, stepRef.current);
      for (const job of dropped) {
        if (job.kind === "explain") setReply(job.key, { status: "dropped", text: "" });
      }
      queueRef.current = [...queueRef.current.filter((job) => !mine.includes(job)), ...rest];
      sync();
      if (!next) continue;
      runningRef.current[lane] = next;
      setRunningByLane((prev) => ({ ...prev, [lane]: next }));
      void run(next, lane)
        .catch((err: unknown) => {
          console.warn("[english-course] turn failed", err);
          if (next.kind === "explain" || next.kind === "review") setReply(next.key, { status: "failed", text: "" });
          if (next.kind === "lesson") {
            setLessons((prev) => ({ ...prev, [next.levelId]: { status: "failed", error: String(err) } }));
          }
          if (next.kind === "voice") setVoices((prev) => ({ ...prev, [next.key]: { status: "failed", error: String(err) } }));
        })
        .finally(() => {
          runningRef.current[lane] = null;
          setRunningByLane((prev) => ({ ...prev, [lane]: null }));
          pumpRef.current();
        });
    }
  }, [run]);
  pumpRef.current = pump;

  // 会话就绪（或者恢复好了）就开始跑排着的活；两个会话各看各的。
  useEffect(() => {
    if (conversation.phase === "ready") pump();
  }, [conversation.phase, pump]);
  useEffect(() => {
    if (background?.phase !== "ready") return;
    // 第二个会话从建到就绪多久（预热池里没有它的位置时是冷启动）。
    mark("bg-ready", `${background.elapsed}s ${background.sessionId ?? ""}`);
    pump();
  }, [background?.phase, pump]);

  // 第二个会话建不起来（error / unconfigured）：记成不可用，出题活回落到主会话。
  useEffect(() => {
    if (!background || backgroundFailedRef.current) return;
    if (background.phase !== "error" && background.phase !== "unconfigured") return;
    backgroundFailedRef.current = true;
    // 出题活改走主会话那条道：同步一下队列，主会话要是也已经死了，收尾的 effect 会把它们收掉。
    sync();
    mark("bg-fallback", `第二个会话不可用（${background.phase}${background.error ? `：${background.error}` : ""}），出题回到主会话`);
    pumpRef.current();
  }, [background, background?.phase]);

  // 会话最后没起来：排着的活不会再跑了，逐件收尾（跟读给出错误、讲解和点评标失败、出题标没出成），
  // 不让页面一直停在「排队中」。
  useEffect(() => {
    if (conversation.phase !== "error" && conversation.phase !== "unconfigured") return;
    // 只收尾主会话那条道上的：第二个会话还能用时，它那条道上的出题活照样能跑。
    const usable = backgroundUsable();
    const { rest, drained } = drainQueue(queueRef.current, (job) => laneOf(job, usable) === "main");
    if (drained.length === 0) return;
    queueRef.current = rest;
    sync();
    const reason = conversation.phase === "error" ? "会话没起来，这次没发出去" : "这个视角的 Agent 还没接入";
    for (const job of drained) {
      if (job.kind === "voice") setVoices((prev) => ({ ...prev, [job.key]: { status: "failed", error: `${reason}，可以先跳过这道。` } }));
      if (job.kind === "explain" || job.kind === "review") setReply(job.key, { status: "failed", text: "" });
      if (job.kind === "lesson") setLessons((prev) => (prev[job.levelId]?.status === "ready" ? prev : { ...prev, [job.levelId]: { status: "failed", error: reason } }));
    }
    // 依赖里带上队列：主会话已经死了以后才进队的活（比如第二个会话上的出题失败、自动重出时回落到
    // 主会话那条道）也要收尾，不能只靠 phase 变的那一下。
  }, [conversation.phase, queue]);

  // ── 页面调用的入口 ────────────────────────────────────────────────────────

  const lessonStatus = useCallback(
    (levelId: string): LessonStatus => {
      if (lessons[levelId]?.status === "ready") return "ready";
      const provides = (job: Job) => job.kind === "lesson" && job.levelId === levelId;
      if ((running && provides(running)) || (runningBackground && provides(runningBackground))) return "running";
      if (queue.some(provides)) return "queued";
      if (lessons[levelId]?.status === "failed") return "failed";
      return "none";
    },
    [lessons, queue, running, runningBackground],
  );

  /**
   * 编号为 `lessonId` 的这一关还有没有活在给它出题（在跑或在排队）。没有了，就不会再有
   * 批次来——播放器据此把手上这一关按「到齐」收尾。
   */
  const isSupplying = useCallback(
    (lessonId: string | undefined): boolean => {
      if (!lessonId) return false;
      const supplies = (job: Job) => job.kind === "lesson" && job.lessonId === lessonId;
      return Boolean((running && supplies(running)) || (runningBackground && supplies(runningBackground)) || queue.some(supplies));
    },
    [queue, running, runningBackground],
  );

  /**
   * 要出单元 3 的一关。
   * - 已经在跑：不再要（跑完的那一版由页面决定收不收）；
   * - 还在排队：换成新的消息（错题以这一次为准），学员点开了就提成 urgent；
   * - 都没有：排一个。之前没出成的失败记录清掉。
   */
  const requestLesson = useCallback(
    (levelId: string, { urgent, compose }: { urgent: boolean; compose: ComposeLesson }) => {
      const provides = (job: Job) => job.kind === "lesson" && job.levelId === levelId;
      if (Object.values(runningRef.current).some((job) => job && provides(job))) return;
      const queued = queueRef.current.find(provides);
      if (queued) {
        queueRef.current = queueRef.current.map((job) => (job.id === queued.id ? { ...job, compose } : job));
        if (urgent) queueRef.current = promote(queueRef.current, queued.id, Date.now());
        sync();
        pumpRef.current();
        return;
      }
      setLessons((prev) => {
        if (prev[levelId]?.status !== "failed") return prev;
        const { [levelId]: _failed, ...rest } = prev;
        return rest;
      });
      enqueueLesson(levelId, urgent, compose);
    },
    [enqueueLesson],
  );

  /** 学员打开了单元 3 的某一关：还在排队的重出作废（打开过的那一关不再被换掉）。 */
  const cancelLesson = useCallback((levelId: string) => {
    const before = queueRef.current.length;
    queueRef.current = queueRef.current.filter((job) => !(job.kind === "lesson" && job.levelId === levelId));
    if (queueRef.current.length !== before) sync();
  }, []);

  /** 【单元结算】：一个单元做完，后台要一句点评。 */
  const requestReview = useCallback(
    (key: string, message: string) => {
      enqueue({ ...newJob("review", false), key, message });
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

  /** 学员点了「为什么」：好了就直接看；排着的插到最前；丢了 / 失败了就重新要一次（urgent）。 */
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

  /** 学员点了「继续」离开这道题：它的讲解不再算点过；步数 +1，过期的后台讲解随之丢掉。 */
  const leaveQuestion = useCallback((explainKey: string | null, steps = 1) => {
    if (explainKey) {
      const job = queueRef.current.find((j) => j.kind === "explain" && j.key === explainKey);
      if (job) queueRef.current = demote(queueRef.current, job.id);
    }
    stepRef.current += steps;
    // 过期的就地标成 dropped（不等下一次 pump，学员回看时状态是对的）。
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

  /** 学员跳过了这道跟读：还排着的那次录音不发了。 */
  const skipVoice = useCallback((key: string) => {
    const before = queueRef.current.length;
    queueRef.current = dropVoice(queueRef.current, key);
    if (queueRef.current.length === before) return;
    sync();
    setVoices((prev) => {
      const { [key]: _dropped, ...rest } = prev;
      return rest;
    });
  }, []);

  // ── 正在跑的那一件：流式看得到的东西 ────────────────────────────────────────

  /** 一个会话上正在流的那条 agent 消息。 */
  const streamingOf = (messages: Conversation["messages"] | undefined) => {
    const last = [...(messages ?? [])].reverse().find((m) => m.role === "agent");
    return last && last.role === "agent" && last.streaming ? last : null;
  };
  const pending = useMemo(() => (running ? streamingOf(conversation.messages) : null), [conversation.messages, running]);
  const pendingBackground = useMemo(
    () => (runningBackground ? streamingOf(background?.messages) : null),
    [background?.messages, runningBackground],
  );
  /** 正在出题的那一件（在哪条道上都行）和它的流。 */
  const lessonRun = useMemo(() => {
    if (runningBackground?.kind === "lesson") return { job: runningBackground, pending: pendingBackground, lane: "background" as const };
    if (running?.kind === "lesson") return { job: running, pending, lane: "main" as const };
    return null;
  }, [pending, pendingBackground, running, runningBackground]);

  // 出题的回合还在跑，流里已经有 present_lesson 了（入参到了，或者结果回来了）：这一关
  // 先标成能开。学员正在等这一关时，不必等工具执行完、回合结束。
  useEffect(() => {
    if (!lessonRun?.pending || lessonRun.job.kind !== "lesson") return;
    const { pending, lane } = lessonRun;
    const { levelId, lessonId } = lessonRun.job;
    // 回合还在跑：只拼从第 1 批起连续的批次，且一律不算齐（草稿可能被拒）——到齐只认回合终态的
    // settleLesson。盖上页面自己的编号。缺听音或跟读的草稿不先放出来（终态时会被拒、重出）。
    const found = lessonFromCards(liveLessonCards(pending.cards, pending.drafts ?? []), { live: true });
    if (!found || !meetsVoiceRequirement(found)) return;
    const content = stampLesson(found, lessonId);
    const before = lessonsRef.current[levelId];
    const sameLesson = before?.status === "ready" && before.content.lessonId === lessonId;
    // 同一关只增不减（草稿画出的题已经交给播放器了）。
    if (sameLesson && before.content.exercises.length >= content.exercises.length) return;
    const readyMs = sameLesson ? before.readyMs : Date.now() - runStartedRef.current[lane];
    if (!sameLesson) {
      mark("w1-first-batch", `${levelId} ${readyMs}ms ${content.exercises.length} 题${content.complete ? "（整关）" : "（后面还有）"}`);
    }
    setLessons((prev) => ({ ...prev, [levelId]: { status: "ready", content, readyMs } }));
  }, [lessonRun]);

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
      levelId: running.kind === "lesson" ? running.levelId : null,
      text,
      stage: pending?.stage ?? "waiting",
    };
  }, [pending, running]);

  /** 正在出单元 3 的那一件（不管在哪个会话上）：等题界面、路径图底部那行看它。 */
  const lessonLive = useMemo<LiveTurn | null>(() => {
    if (!lessonRun || lessonRun.job.kind !== "lesson") return null;
    return {
      kind: "lesson",
      replyKey: null,
      levelId: lessonRun.job.levelId,
      text: lessonRun.pending?.text ?? "",
      stage: lessonRun.pending?.stage ?? "waiting",
    };
  }, [lessonRun]);

  return {
    lessons,
    replies,
    voices,
    live,
    lessonLive,
    running: running ? { kind: running.kind, id: running.id } : null,
    lessonStatus,
    isSupplying,
    requestLesson,
    cancelLesson,
    requestReview,
    prepareExplain,
    openExplain,
    leaveQuestion,
    sendVoice,
    skipVoice,
  };
}

export type LessonChannel = ReturnType<typeof useLessonChannel>;
