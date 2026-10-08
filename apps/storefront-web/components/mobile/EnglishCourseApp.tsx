"use client";

/**
 * 英语小课：闯关式的「路径图 + 关卡播放器」。
 *
 * 和一期、二期最大的不同：**没有常驻的 agent 输出**。孩子的每个操作（选、拼、检查、继续）
 * 都在本地立刻有画面和声音，不等模型；agent 只在这几个时刻出场：
 * - W0 进页面就建会话（后台，不挡路径图）；
 * - W1 会话就绪就预出当前那一关（`present_lesson` 一次给一关的题，冷启那一关分两批）；
 * - W2 答错时后台要讲解，孩子点「为什么」才显示；
 * - W3 跟读的语音回合：转写先回、本地逐词比对，文字点评点「看点评」才显示；
 * - W4 结算：本地数字立刻出来，agent 的一句点评流进来，同一轮里按这一关的错题出下一关。
 * 同一时刻只跑一个回合，排队规则见 `lib/course/turn-queue.ts`。
 *
 * 进度（通关、XP、连胜、最长连对）只存 localStorage，按访客 id 分键（`lib/showcase/progress.ts`）。
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Conversation } from "@/components/agent/useAgentConversation";
import {
  answerText,
  playContentFor,
  settlementMessage,
  type Answer,
  type Exercise,
  type LessonContent,
} from "@/lib/course/english-lesson";
import { currentStop, nextStop, PATH, stopLabel, type PathStop } from "@/lib/course/english-path";
import { summarize, type PlayerState, type PlayerSummary } from "@/lib/course/lesson-player";
import { sfx } from "@/lib/course/sfx";
import { finishLesson, readProgress, setPathOrder, XP_PER_LESSON, type CourseProgress } from "@/lib/showcase/progress";
import { EnStatusBar } from "./english/EnIcons";
import { LessonPlayer } from "./english/LessonPlayer";
import { LessonLoading, PathMap, ResultScreen } from "./english/screens";
import { useLessonChannel } from "./english/useLessonChannel";
import { useSpeech } from "./english/useSpeech";

// 旧存档（路径图之前写的）按「上过几节」折算成通关前几关，要先知道路径的顺序。
setPathOrder(PATH.map((stop) => stop.level.id));

type Screen =
  | { name: "map" }
  | { name: "loading"; stop: PathStop; since: number }
  | { name: "play"; stop: PathStop; runId: number; content: LessonContent }
  | {
      name: "result";
      stop: PathStop;
      summary: PlayerSummary<Answer>;
      streak: number;
      reviewKey: string | null;
      /** 结算点评里要的下一关（它的 lesson_id），用来认「下一关是不是照这次的错题出好了」。 */
      next: { levelId: string; lessonId: string } | null;
    };

function mark(name: string, detail: string) {
  try {
    performance.mark(`en:${name}`, { detail });
  } catch {
    // 读数还在 console 里
  }
  console.info(`[english-course] ${name} ${detail}`);
}

function speechTexts(content: LessonContent): string[] {
  return content.exercises.flatMap((exercise) =>
    exercise.type === "listen_choice" ? [exercise.audio_text] : exercise.type === "read_aloud" ? [exercise.text] : [],
  );
}

export function EnglishCourseApp({
  conversation,
  visitorId,
}: {
  conversation: Conversation;
  /** XP / 连胜 / 通关按这个身份分键；还没拿到身份时读写都空转。 */
  visitorId: string | null;
  /** CaseStage 对所有上课界面统一传的几项；路径图版不用（没有欢迎屏和开场白按钮）。 */
  openers?: string[];
  lessonTitle?: string;
  teacherName?: string;
  welcomeText?: string;
}) {
  const channel = useLessonChannel(conversation);
  const speech = useSpeech();
  const [progress, setProgress] = useState<CourseProgress | null>(null);
  const [screen, setScreen] = useState<Screen>({ name: "map" });
  const runSeq = useRef(0);
  const [now, setNow] = useState(() => Date.now());

  // 进度只属于这个访客：身份一换就重新读一把。
  useEffect(() => {
    setProgress(visitorId ? readProgress(visitorId) : null);
  }, [visitorId]);

  // W0：进页面就建会话（有了访客 id 再建，会话和进度用的是同一个身份）。
  const { phase, start } = conversation;
  useEffect(() => {
    if (visitorId && phase === "idle") start();
  }, [visitorId, phase, start]);

  const canAskAgent = phase !== "idle" && phase !== "unconfigured" && phase !== "error";
  const current = useMemo(() => currentStop(progress?.completed ?? []), [progress]);

  // W1：会话一建（就绪前就排上，就绪即跑）就预出当前那一关。结算时下一关由点评那一轮带出，
  // 那时它已经在队里（lessonStatus = queued/running），这里不会重复要。
  useEffect(() => {
    if (!progress || !canAskAgent || screen.name === "result") return;
    if (channel.lessonStatus(current.level.id) === "none") {
      channel.requestLesson(current.level.id, { urgent: false });
    }
  }, [canAskAgent, channel, current, progress, screen.name]);

  // 开关时预取本关所有读音：题一到手（包括后台预出的、分批后到的）就取，开关时多半已经在本地了。
  const prefetched = useRef(new Set<string>());
  const { prefetch } = speech;
  useEffect(() => {
    for (const [levelId, slot] of Object.entries(channel.lessons)) {
      if (slot.status !== "ready") continue;
      const key = `${slot.content.lessonId ?? levelId}:${slot.content.exercises.length}`;
      if (prefetched.current.has(key)) continue;
      prefetched.current.add(key);
      void prefetch(speechTexts(slot.content));
    }
  }, [channel.lessons, prefetch]);

  const startRun = useCallback(
    (stop: PathStop, content: LessonContent, waitedMs: number) => {
      runSeq.current += 1;
      mark("w1-open-wait", `${stop.level.id} ${waitedMs}ms（${content.exercises.length} 题${content.complete ? "" : "，后面的还在出"}）`);
      void prefetch(speechTexts(content));
      setScreen({ name: "play", stop, runId: runSeq.current, content });
    },
    [prefetch],
  );

  const openStop = useCallback(
    (stop: PathStop) => {
      const slot = channel.lessons[stop.level.id];
      if (slot?.status === "ready") {
        startRun(stop, slot.content, 0);
        return;
      }
      channel.requestLesson(stop.level.id, { urgent: true });
      setScreen({ name: "loading", stop, since: Date.now() });
    },
    [channel, startRun],
  );

  // 等题：题一到（分批的第一批也算）就开；等待秒数每秒刷新。
  useEffect(() => {
    if (screen.name !== "loading") return;
    const slot = channel.lessons[screen.stop.level.id];
    if (slot?.status === "ready") startRun(screen.stop, slot.content, Date.now() - screen.since);
  }, [channel.lessons, screen, startRun]);
  useEffect(() => {
    if (screen.name !== "loading" && phase !== "creating" && phase !== "starting") return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [screen.name, phase]);

  // 正在玩的这一关：同一关（页面编号相同）的后续批次接进来；别的出题结果（比如点评那一轮
  // 出的下一关）不会换掉手上这一关；给它出题的活已经不在了就按「到齐」收尾。
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
      const { stop, runId } = screen;
      const summary = summarize(state);
      const updated = finishLesson(visitorId, { levelId: stop.level.id, combo: summary.bestCombo });
      setProgress(updated);
      sfx.complete();
      channel.leaveQuestion(null, 2);

      let reviewKey: string | null = null;
      let next: { levelId: string; lessonId: string } | null = null;
      if (canAskAgent) {
        const after = nextStop(stop.level.id);
        next = after ? { levelId: after.level.id, lessonId: channel.newLessonId(after.level.id) } : null;
        reviewKey = `${runId}:review`;
        const message = settlementMessage({
          label: stopLabel(stop),
          firstCorrect: summary.firstCorrect,
          scored: summary.scored,
          durationMs: summary.durationMs,
          // 错题按孩子实际看到的那份题对（草稿换过的题不会挂错）。
          mistakes: summary.mistakes.map(({ index, answer }) => ({
            exercise: exercises[index],
            answer: answerText(exercises[index], answer),
          })),
          next: after && next ? { label: stopLabel(after), goal: after.level.goal, lessonId: next.lessonId } : null,
        });
        channel.requestReview(reviewKey, message, next);
      }
      setScreen({ name: "result", stop, summary, streak: updated.streak, reviewKey, next });
    },
    [canAskAgent, channel, screen, visitorId],
  );

  // ── 渲染 ──────────────────────────────────────────────────────────────────

  if (screen.name === "play" && playContent) {
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
        ? "这个视角的 Agent 还没接入（站点没有配置 edu-english-coach），出不了题。"
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
          live={channel.live && channel.live.levelId === levelId ? channel.live : null}
          waitedSeconds={Math.max(0, Math.round((now - screen.since) / 1000))}
          problem={problem}
          onBack={() => setScreen({ name: "map" })}
          onRetry={slot?.status === "failed" ? () => channel.requestLesson(levelId, { urgent: true }) : null}
        />
      </div>
    );
  }

  if (screen.name === "result") {
    const nextSlot = screen.next ? channel.lessons[screen.next.levelId] : undefined;
    const nextReady = Boolean(
      screen.next && nextSlot?.status === "ready" && nextSlot.content.lessonId === screen.next.lessonId,
    );
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
          canAskAgent={screen.reviewKey !== null}
          nextNote={
            nextReady
              ? screen.summary.mistakes.length > 0
                ? "下一关已经照着这一关的错题出好了"
                : "下一关已经出好了"
              : null
          }
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
        lessonStatus={channel.lessonStatus}
        agentLine={agentLine(conversation, channel.live, channel.lessonStatus(current.level.id), current)}
        onOpen={openStop}
      />
    </div>
  );
}

/** 路径图底部那一行：agent 这会儿在干什么。 */
function agentLine(
  conversation: Conversation,
  live: ReturnType<typeof useLessonChannel>["live"],
  currentStatus: ReturnType<ReturnType<typeof useLessonChannel>["lessonStatus"]>,
  current: PathStop,
): { tone: "busy" | "ok" | "bad" | "idle"; text: string } {
  switch (conversation.phase) {
    case "idle":
    case "creating":
    case "starting":
      return { tone: "busy", text: `Emma 老师正在进教室… ${conversation.elapsed}s` };
    case "reviving":
      return { tone: "busy", text: "会话闲置后被回收了，正在恢复" };
    case "unconfigured":
      return { tone: "bad", text: "这个视角的 Agent 还没接入，出不了题" };
    case "error":
      return { tone: "bad", text: conversation.error ?? "会话出错了" };
    default:
      break;
  }
  if (live?.kind === "lesson" || (live?.kind === "review" && live.levelId)) {
    const stop = PATH.find((s) => s.level.id === live.levelId);
    return { tone: "busy", text: `Emma 老师在出「${stop?.level.title ?? "下一关"}」的题…` };
  }
  if (live?.kind === "review") return { tone: "busy", text: "Emma 老师在写点评…" };
  if (currentStatus === "ready") return { tone: "ok", text: `「${current.level.title}」的题备好了，点「开始」` };
  if (live) return { tone: "busy", text: "Emma 老师在忙上一件事…" };
  return { tone: "ok", text: "Emma 老师就绪" };
}
