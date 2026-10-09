"use client";

/**
 * 英语小课：路径图 + 关卡播放器，一屏一题。
 *
 * 课程 v2 的结构：
 * - 单元 1、2 是**静态**的：题写死在 `lib/course/units/*.json`，所有学员一样。点开一关题就在本地，
 *   每一题都不等 agent。
 * - 单元 3 **课中生成**：单元 1 或 2 的第 k 关做完，后台让 agent 带上到这一刻为止的错题出单元 3 的
 *   第 k 关（规则见 `english-path.ts` 的 `generationTarget`）。单元 2 做完才解锁；学员点开时还没出好，
 *   就显示「正在根据你的错题生成」。
 *
 * agent 只在这几个时刻出场，其余都在页面本地：
 * - 后台出单元 3 的一关（【出题】，`present_lesson` 一批出齐）；
 * - 答错时后台要讲解，学员点「为什么」才显示（【为什么】）；
 * - 跟读的语音回合：转写先回、本地逐词比对，文字点评点「看点评」才显示；
 * - 一个单元的最后一关做完，写一句单元点评（【单元结算】）。其余各关的结算屏只有本地数字。
 * 主会话进页面就建（W0），不挡路径图；单元 3 的出题跑在第二个会话上（第一件出题活来了才建），讲解、跟读、
 * 单元点评留在主会话，两边互不排队；第二个会话不可用就回落到主会话。每个会话同一时刻只跑一个回合，
 * 排队规则见 `lib/course/turn-queue.ts`（`laneOf` 定哪件活走哪个会话）。
 *
 * 进度（通关、XP、连胜、最长连对）存 `lib/showcase/progress.ts`；错题、每关成绩、单元 3 出好的关
 * 存 `lib/course/course-store.ts`。都只在本机 localStorage，按访客 id 分键。
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Conversation } from "@/components/agent/useAgentConversation";
import {
  answerText,
  GENERATE_MISTAKE_LIMIT,
  generateLessonMessage,
  lessonFromCards,
  playContentFor,
  stampLesson,
  unitReviewMessage,
  type Answer,
  type Exercise,
  type LessonContent,
  type Mistake,
} from "@/lib/course/english-lesson";
import {
  currentStop,
  generationTarget,
  isUnitEnd,
  PATH,
  staticLevelPayload,
  stopById,
  stopLabel,
  unitLabel,
  type PathStop,
} from "@/lib/course/english-path";
import {
  acceptGenerated,
  canRegenerate,
  markOpened,
  readCourse,
  recentMistakes,
  recordLesson,
  saveGenerated,
  writeCourse,
  type CourseState,
} from "@/lib/course/course-store";
import { summarize, type PlayerState, type PlayerSummary } from "@/lib/course/lesson-player";
import { lessonClips } from "@/lib/course/course-audio";
import { sfx } from "@/lib/course/sfx";
import { finishLesson, readProgress, XP_PER_LESSON, type CourseProgress } from "@/lib/showcase/progress";
import { EnStatusBar } from "./english/EnIcons";
import { LessonPlayer } from "./english/LessonPlayer";
import { LessonLoading, PathMap, ResultScreen, type GenerationNote } from "./english/screens";
import { useLessonChannel, type LessonStatus } from "./english/useLessonChannel";
import { useSpeech } from "./english/useSpeech";

type Screen =
  | { name: "map" }
  | { name: "loading"; stop: PathStop; since: number }
  | { name: "play"; stop: PathStop; runId: number; content: LessonContent; openedAt: number }
  | {
      name: "result";
      stop: PathStop;
      summary: PlayerSummary<Answer>;
      streak: number;
      /** 单元最后一关才有：单元点评落在 `replies` 的哪个键上。 */
      reviewKey: string | null;
      /** 这一关做完后出（或重出）的单元 3 那一关；没有是 null。 */
      generating: string | null;
    };

function mark(name: string, detail: string) {
  try {
    performance.mark(`en:${name}`, { detail });
  } catch {
    // 读数还在 console 里
  }
  console.info(`[english-course] ${name} ${detail}`);
}

/** 一关当成一张 `lesson` 卡走 `lessonFromCards`（静态关和本机存下的单元 3 都这么取），盖上页面编号。 */
function lessonFromPayload(payload: unknown, lessonId: string): LessonContent | null {
  const found = lessonFromCards([{ id: lessonId, component: "lesson", payload }]);
  return found ? stampLesson(found, lessonId) : null;
}

const staticCache = new Map<string, LessonContent | null>();
/** 静态关的题（单元 1、2）；单元 3 返回 null。 */
function staticContent(levelId: string): LessonContent | null {
  if (!staticCache.has(levelId)) {
    const payload = staticLevelPayload(levelId);
    staticCache.set(levelId, payload ? lessonFromPayload(payload, levelId) : null);
  }
  return staticCache.get(levelId) ?? null;
}

/**
 * 本机存下的单元 3 那一关：读回来再过一遍取题链路（本机存的东西也当外部输入），编号和出处照旧
 * （出处是取运行时读音的坐标，会话结束以后那一轮照样读得到）。
 */
function storedContent(course: CourseState, levelId: string): LessonContent | null {
  const saved = course.unit3[levelId];
  if (!saved?.lessonId) return null;
  const content = lessonFromPayload({ exercises: saved.exercises, title: saved.title, focus: saved.focus }, saved.lessonId);
  const origin = saved.origin;
  const validOrigin = origin && typeof origin.sessionId === "string" && typeof origin.turnId === "string" ? origin : undefined;
  return content && validOrigin ? { ...content, origin: validOrigin } : content;
}

export function EnglishCourseApp({
  conversation,
  background = null,
  visitorId,
}: {
  conversation: Conversation;
  /** 第二个 coach 会话：专跑单元 3 的后台出题。不传就是单会话，出题和讲解排一个队。 */
  background?: Conversation | null;
  /** XP / 连胜 / 通关按这个身份分键；还没拿到身份时读写都空转。 */
  visitorId: string | null;
  /** CaseStage 对所有上课界面统一传的几项；路径图版不用（没有欢迎屏和开场白按钮）。 */
  openers?: string[];
  lessonTitle?: string;
  teacherName?: string;
  welcomeText?: string;
}) {
  const channel = useLessonChannel(conversation, background);
  const speech = useSpeech();
  const [progress, setProgress] = useState<CourseProgress | null>(null);
  const [course, setCourseState] = useState<CourseState>(() => readCourse(null));
  const courseRef = useRef(course);
  const [screen, setScreen] = useState<Screen>({ name: "map" });
  const runSeq = useRef(0);
  const [now, setNow] = useState(() => Date.now());

  // 课程状态改了就落盘（读改写都在这一个页面里，没有竞争要防）。
  const setCourse = useCallback(
    (next: CourseState) => {
      courseRef.current = next;
      setCourseState(next);
      writeCourse(visitorId, next);
    },
    [visitorId],
  );

  // 进度只属于这个访客：身份一换就重新读一把。
  useEffect(() => {
    setProgress(visitorId ? readProgress(visitorId) : null);
    const loaded = readCourse(visitorId);
    courseRef.current = loaded;
    setCourseState(loaded);
  }, [visitorId]);

  // W0：进页面就建会话（有了访客 id 再建，会话和进度用的是同一个身份）。
  const { phase, start } = conversation;
  useEffect(() => {
    if (visitorId && phase === "idle") start();
  }, [visitorId, phase, start]);

  const canAskAgent = phase !== "idle" && phase !== "unconfigured" && phase !== "error";
  const current = useMemo(() => currentStop(progress?.completed ?? []), [progress]);

  /** 单元 3 那一关拼【出题】消息：错题取入队这一刻的，重出时只换编号。 */
  const composeFor = useCallback((target: PathStop, state: CourseState) => {
    const mistakes = recentMistakes(state, GENERATE_MISTAKE_LIMIT);
    return (lessonId: string) => generateLessonMessage({ label: stopLabel(target), lessonId, mistakes });
  }, []);

  /** 一关能不能开、开哪一份：静态关恒在；单元 3 先看本机存下的，再看通道里正在出的那一版。 */
  const contentFor = useCallback(
    (stop: PathStop): LessonContent | null => {
      if (stop.unit.kind === "static") return staticContent(stop.level.id);
      const stored = storedContent(course, stop.level.id);
      if (stored) return stored;
      const slot = channel.lessons[stop.level.id];
      return slot?.status === "ready" ? slot.content : null;
    },
    [channel.lessons, course],
  );

  const statusFor = useCallback(
    (levelId: string): LessonStatus => {
      const stop = stopById(levelId);
      if (!stop) return "none";
      if (stop.unit.kind === "static" || storedContent(course, levelId)) return "ready";
      return channel.lessonStatus(levelId);
    },
    [channel, course],
  );

  // 单元 3 出好的关存进本机：回合到终态（`complete`）才存；打开过的只认打开的那一版（`acceptGenerated`）。
  useEffect(() => {
    let next = courseRef.current;
    for (const [levelId, slot] of Object.entries(channel.lessons)) {
      if (slot.status !== "ready" || !slot.content.complete || !slot.content.lessonId) continue;
      if (next.unit3[levelId]?.lessonId === slot.content.lessonId) continue;
      if (!acceptGenerated(next, levelId, slot.content)) continue;
      next = saveGenerated(next, levelId, slot.content);
    }
    if (next !== courseRef.current) setCourse(next);
  }, [channel.lessons, setCourse]);

  // 读音预取：路径图上亮着的那一关、通道里出好的单元 3 各关，题一到手就取，开关时多半已经在本地了。
  // 单元 3 那一关回合终态时才记下出处（`origin`），出处到了要再预取一次（键里带上它）。
  const prefetched = useRef(new Set<string>());
  const { prefetch } = speech;
  const prefetchContent = useCallback(
    (content: LessonContent) => {
      const key = `${content.lessonId}:${content.exercises.length}:${content.origin?.turnId ?? ""}`;
      if (prefetched.current.has(key)) return;
      prefetched.current.add(key);
      void prefetch(lessonClips(content));
    },
    [prefetch],
  );
  useEffect(() => {
    if (!progress || screen.name !== "map") return;
    const content = contentFor(current);
    if (content) prefetchContent(content);
  }, [contentFor, current, prefetchContent, progress, screen.name]);
  useEffect(() => {
    for (const slot of Object.values(channel.lessons)) {
      if (slot.status === "ready") prefetchContent(slot.content);
    }
  }, [channel.lessons, prefetchContent]);

  const startRun = useCallback(
    (stop: PathStop, content: LessonContent, waitedMs: number, openedAt: number) => {
      runSeq.current += 1;
      if (stop.unit.kind === "generated" && content.lessonId) {
        // 打开过的单元 3 那一关不再重出：排着的重出作废，在跑的那一版出来也不收（`acceptGenerated`）。
        setCourse(markOpened(courseRef.current, stop.level.id, content.lessonId));
        channel.cancelLesson(stop.level.id);
      }
      mark("w1-open-wait", `${stop.level.id} ${waitedMs}ms（${content.exercises.length} 题${content.complete ? "" : "，后面的还在出"}）`);
      prefetchContent(content);
      setScreen({ name: "play", stop, runId: runSeq.current, content, openedAt });
    },
    [channel, prefetchContent, setCourse],
  );

  const openStop = useCallback(
    (stop: PathStop) => {
      // 「点开 → 第一题可答」的起点（目标 p50 < 1 s，页面用 performance mark 计）。
      const openedAt = performance.now();
      mark("open", stop.level.id);
      const content = contentFor(stop);
      if (content) {
        startRun(stop, content, 0, openedAt);
        return;
      }
      if (canAskAgent) {
        channel.requestLesson(stop.level.id, { urgent: true, compose: composeFor(stop, courseRef.current) });
      }
      setScreen({ name: "loading", stop, since: Date.now() });
    },
    [canAskAgent, channel, composeFor, contentFor, startRun],
  );

  // 等单元 3 的题：题一到就开；等待秒数每秒刷新。
  useEffect(() => {
    if (screen.name !== "loading") return;
    const content = contentFor(screen.stop);
    if (content) startRun(screen.stop, content, Date.now() - screen.since, performance.now());
  }, [contentFor, screen, startRun]);
  useEffect(() => {
    if (screen.name !== "loading" && phase !== "creating" && phase !== "starting") return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [screen.name, phase]);

  // 正在玩的这一关：同一关（页面编号相同）的后续批次接进来；别的出题结果不会换掉手上这一关；
  // 给它出题的活已经不在了就按「到齐」收尾。静态关开的时候就是齐的。
  const { isSupplying } = channel;
  const playContent = useMemo(() => {
    if (screen.name !== "play") return null;
    const slot = channel.lessons[screen.stop.level.id];
    return playContentFor(
      screen.content,
      slot?.status === "ready" ? slot.content : null,
      isSupplying(screen.content.lessonId),
    );
  }, [channel.lessons, isSupplying, screen]);

  const exitToMap = useCallback(() => {
    // 离开一关：这一关里还没开始的讲解都没地方显示了，一并作废（turn-queue.ts 第 3 条）。
    channel.leaveQuestion(null, 2);
    setScreen({ name: "map" });
  }, [channel]);

  const finish = useCallback(
    (state: PlayerState<Answer>, exercises: readonly Exercise[]) => {
      if (screen.name !== "play") return;
      const { stop } = screen;
      const summary = summarize(state);
      const updated = finishLesson(visitorId, { levelId: stop.level.id, combo: summary.bestCombo });
      setProgress(updated);
      sfx.complete();
      channel.leaveQuestion(null, 2);

      const where = stopLabel(stop);
      // 错题按学员实际看到的那份题对（草稿换过的题不会挂错）。
      const mistakes: Mistake[] = summary.mistakes.map(({ index, answer }) => ({
        exercise: exercises[index],
        answer: answerText(exercises[index], answer),
        where,
      }));
      const levelNo = stop.unit.levels.indexOf(stop.level) + 1;
      const recorded = recordLesson(courseRef.current, {
        levelId: stop.level.id,
        result: { label: `第 ${levelNo} 关`, firstCorrect: summary.firstCorrect, scored: summary.scored },
        mistakes,
        at: Date.now(),
      });
      setCourse(recorded);

      let reviewKey: string | null = null;
      if (canAskAgent && isUnitEnd(stop)) {
        // 【单元结算】排在出题之前：学员正看着结算屏等这句点评。
        reviewKey = `${screen.runId}:unit-review`;
        const unitIds = new Set(stop.unit.levels.map((level) => level.id));
        channel.requestReview(
          reviewKey,
          unitReviewMessage({
            unitLabel: unitLabel(stop.unit),
            lessons: stop.unit.levels.flatMap((level) => recorded.results[level.id] ?? []),
            mistakes: recentMistakes(recorded, 8, (m) => unitIds.has(m.levelId)),
            last: stop.unit.kind === "generated",
          }),
        );
      }

      const targetId = generationTarget(stop.level.id);
      const target = targetId ? stopById(targetId) : undefined;
      let generating: string | null = null;
      if (canAskAgent && target && canRegenerate(recorded, target.level.id, updated.completed)) {
        channel.requestLesson(target.level.id, { urgent: false, compose: composeFor(target, recorded) });
        generating = target.level.id;
      }
      setScreen({ name: "result", stop, summary, streak: updated.streak, reviewKey, generating });
    },
    [canAskAgent, channel, composeFor, screen, setCourse, visitorId],
  );

  // ── 渲染 ──────────────────────────────────────────────────────────────────

  if (screen.name === "play" && playContent) {
    const { stop, openedAt } = screen;
    return (
      <div className="m-app en-app">
        <EnStatusBar />
        <LessonPlayer
          key={screen.runId}
          runId={screen.runId}
          content={playContent}
          channel={channel}
          speech={speech}
          canAskAgent={canAskAgent}
          onFirstQuestion={() => mark("open-to-question", `${stop.level.id} ${Math.round(performance.now() - openedAt)}ms`)}
          onExit={exitToMap}
          onFinish={finish}
        />
      </div>
    );
  }

  if (screen.name === "loading") {
    const levelId = screen.stop.level.id;
    const slot = channel.lessons[levelId];
    const problem =
      phase === "unconfigured"
        ? "这个视角的 Agent 还没接入（站点没有配置 edu-english-coach），单元 3 出不了题。"
        : phase === "error"
          ? `会话创建失败：${conversation.error ?? "未知错误"}`
          : slot?.status === "failed"
            ? `这一关老师没出成（${slot.error}）。`
            : null;
    return (
      <div className="m-app en-app">
        <EnStatusBar />
        <LessonLoading
          stop={screen.stop}
          status={phase === "reviving" ? "queued" : channel.lessonStatus(levelId)}
          live={channel.lessonLive && channel.lessonLive.levelId === levelId ? channel.lessonLive : null}
          waitedSeconds={Math.max(0, Math.round((now - screen.since) / 1000))}
          hasMistakes={course.mistakes.length > 0}
          problem={problem}
          onBack={() => setScreen({ name: "map" })}
          onRetry={
            slot?.status === "failed" && canAskAgent
              ? () => channel.requestLesson(levelId, { urgent: true, compose: composeFor(screen.stop, courseRef.current) })
              : null
          }
        />
      </div>
    );
  }

  if (screen.name === "result") {
    const target = screen.generating ? stopById(screen.generating) : undefined;
    let generation: GenerationNote | null = null;
    if (target) {
      const running = channel.lessonStatus(target.level.id);
      generation = {
        title: target.level.title,
        state:
          running === "running" || running === "queued"
            ? "working"
            : running === "failed" && !storedContent(course, target.level.id)
              ? "failed"
              : "ready",
        withMistakes: screen.summary.mistakes.length > 0 || course.mistakes.length > 0,
      };
    }
    return (
      <div className="m-app en-app">
        <EnStatusBar />
        <ResultScreen
          xp={XP_PER_LESSON}
          accuracy={screen.summary.accuracy}
          durationMs={screen.summary.durationMs}
          streak={screen.streak}
          bestCombo={screen.summary.bestCombo}
          review={screen.reviewKey ? channel.replies[screen.reviewKey] : undefined}
          live={channel.live && screen.reviewKey && channel.live.replyKey === screen.reviewKey ? channel.live : null}
          showReview={screen.reviewKey !== null}
          generation={generation}
          onContinue={() => setScreen({ name: "map" })}
        />
      </div>
    );
  }

  return (
    <div className="m-app en-app">
      <EnStatusBar />
      <PathMap
        progress={progress ?? readProgress(null)}
        current={current}
        lessonStatus={statusFor}
        agentLine={agentLine(conversation, channel.live, channel.lessonLive, statusFor(current.level.id), current)}
        onOpen={openStop}
      />
    </div>
  );
}

/** 路径图底部那一行：agent 这会儿在干什么。 */
function agentLine(
  conversation: Conversation,
  live: ReturnType<typeof useLessonChannel>["live"],
  lessonLive: ReturnType<typeof useLessonChannel>["lessonLive"],
  currentStatus: LessonStatus,
  current: PathStop,
): { tone: "busy" | "ok" | "bad" | "idle"; text: string } {
  // 单元 1、2 和本机存好的单元 3 不需要 agent：会话还没好、甚至没接上，也照样能做题。
  switch (conversation.phase) {
    case "idle":
    case "creating":
    case "starting":
      return { tone: "busy", text: `Emma 老师正在进教室… ${conversation.elapsed}s` };
    case "reviving":
      return { tone: "busy", text: "会话闲置后被回收了，正在恢复" };
    case "unconfigured":
      return {
        tone: "bad",
        text:
          currentStatus === "ready"
            ? "这个视角的 Agent 还没接入：这一关能做，讲解、跟读点评和单元 3 出题用不了"
            : "这个视角的 Agent 还没接入，单元 3 出不了题",
      };
    case "error":
      return { tone: "bad", text: conversation.error ?? "会话出错了" };
    default:
      break;
  }
  // 出题可能在第二个会话上跑（lessonLive），也可能回落在主会话上（live 的 kind 是 lesson）。
  const generating = lessonLive ?? (live?.kind === "lesson" ? live : null);
  if (generating) {
    const stop = PATH.find((s) => s.level.id === generating.levelId);
    return { tone: "busy", text: `Emma 老师在按你的错题出「${stop?.level.title ?? "单元 3"}」…` };
  }
  if (live?.kind === "review") return { tone: "busy", text: "Emma 老师在写单元点评…" };
  if (currentStatus === "ready") return { tone: "ok", text: `「${current.level.title}」的题备好了，点「开始」` };
  if (live) return { tone: "busy", text: "Emma 老师在忙上一件事…" };
  return { tone: "ok", text: "Emma 老师就绪" };
}
