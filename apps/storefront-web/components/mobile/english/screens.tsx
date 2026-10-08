"use client";

/**
 * 英语小课的三块非答题界面：路径图、等题、结算。
 *
 * 等待都给看得见的反馈：路径图底部一行写着 agent 这会儿在干什么（会话启动中 / 在出第几关 /
 * 已备好）；等题界面按事件流的阶段换提示；结算屏的数字本地立刻出来，点评随后流入。
 */

import { formatDuration } from "@/lib/course/english-lesson";
import { PATH, UNITS, isUnlocked, type PathStop } from "@/lib/course/english-path";
import type { CourseProgress } from "@/lib/showcase/progress";
import { Octo } from "../Octo";
import { FlagGB, IconBolt, IconCheck, IconClock, IconClose, IconFlame, IconStar, IconTarget, IconTrophy } from "./EnIcons";
import { STAGE_HINT } from "./LessonPlayer";
import type { LessonStatus, LiveTurn, Reply } from "./useLessonChannel";

// ---------------------------------------------------------------------------
// 路径图
// ---------------------------------------------------------------------------

/** 节点左右摆动的位置（蛇形路径），按关卡在单元里的序号取。 */
const OFFSETS = [0, 52, 0, -52];

export function PathMap({
  progress,
  current,
  lessonStatus,
  agentLine,
  onOpen,
}: {
  progress: CourseProgress;
  current: PathStop;
  lessonStatus: (levelId: string) => LessonStatus;
  /** 底部那一行：agent 这会儿的状态。 */
  agentLine: { tone: "busy" | "ok" | "bad" | "idle"; text: string };
  onOpen: (stop: PathStop) => void;
}) {
  return (
    <div className="en-map">
      <div className="en-top en-map-top">
        <FlagGB />
        <span className="en-hud-item" data-tone="fire" data-zero={progress.streak === 0} title="连胜天数">
          <IconFlame /> {progress.streak}
        </span>
        <span className="en-hud-item" data-tone="xp" title="累计 XP">
          <IconBolt /> {progress.xp}
        </span>
      </div>

      <div className="en-path">
        {UNITS.map((unit, unitIndex) => (
          <section className="en-unit" key={unit.id} data-unit={unitIndex % 3}>
            <header className="en-unit-head" data-unit={unitIndex % 3}>
              <div className="en-unit-text">
                <span>第 {unitIndex + 1} 单元</span>
                <b>{unit.title}</b>
              </div>
              <span className="en-unit-badge" aria-hidden="true">
                {unit.emoji}
              </span>
            </header>
            <div className="en-nodes">
              {unit.levels.map((level, levelIndex) => {
                const stop = PATH.find((s) => s.level.id === level.id) as PathStop;
                const done = progress.completed.includes(level.id);
                const unlocked = isUnlocked(level.id, progress.completed);
                const isCurrent = stop.index === current.index && !done;
                const status = lessonStatus(level.id);
                const state = done ? "done" : isCurrent ? "current" : unlocked ? "open" : "locked";
                const offset = OFFSETS[levelIndex % 4];
                const trophy = levelIndex === 3;
                return (
                  <div className="en-node-row" key={level.id} style={{ transform: `translateX(${offset}px)` }}>
                    {isCurrent ? (
                      <div className="en-node-tip">
                        {status === "ready" ? "开始" : status === "running" ? "老师在出题…" : "开始"}
                      </div>
                    ) : null}
                    <div className="en-node-ring" data-current={isCurrent}>
                      <button
                        type="button"
                        className="en-node"
                        data-state={state}
                        data-kind={trophy ? "trophy" : "lesson"}
                        disabled={!unlocked}
                        onClick={() => onOpen(stop)}
                        aria-label={`${unit.title} · ${level.title}`}
                      >
                        {trophy ? <IconTrophy /> : done ? <IconCheck size={34} stroke={4.5} /> : <IconStar />}
                      </button>
                    </div>
                    {isCurrent ? (
                      <div className="en-node-mascot" data-side={offset > 0 ? "left" : "right"} aria-hidden="true">
                        <Octo mood="idle" size={78} />
                      </div>
                    ) : null}
                  </div>
                );
              })}
            </div>
          </section>
        ))}
      </div>

      <div className="en-agent-line" data-tone={agentLine.tone}>
        <Octo mood={agentLine.tone === "busy" ? "think" : "idle"} size={30} />
        <span>{agentLine.text}</span>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// 等题
// ---------------------------------------------------------------------------

export function LessonLoading({
  stop,
  status,
  live,
  waitedSeconds,
  problem,
  onBack,
  onRetry,
}: {
  stop: PathStop;
  status: LessonStatus;
  live: LiveTurn | null;
  waitedSeconds: number;
  /** 出不了题（agent 没接上 / 这一关没出成）：一句话，加「再试一次」。 */
  problem: string | null;
  onBack: () => void;
  onRetry: (() => void) | null;
}) {
  const hint =
    status === "running" && live
      ? (STAGE_HINT[live.stage] ?? "老师在写题")
      : status === "queued"
        ? "排队中，老师在忙上一件事"
        : "老师在进教室";
  return (
    <div className="en-loading">
      <button type="button" className="en-close en-loading-back" onClick={onBack} aria-label="回到路径图">
        <IconClose />
      </button>
      <Octo mood={problem ? "idle" : "think"} size={110} />
      <h3>
        {stop.unit.emoji} {stop.level.title}
      </h3>
      {problem ? (
        <>
          <p className="en-loading-problem">{problem}</p>
          {onRetry ? (
            <button type="button" className="en-btn en-btn-primary" onClick={onRetry}>
              再试一次
            </button>
          ) : null}
        </>
      ) : (
        <>
          <b className="en-dots">
            {hint}
            <i />
            <i />
            <i />
          </b>
          <div className="en-wait-cards">
            <i />
            <i />
            <i />
          </div>
          <p className="en-loading-sub">Emma 老师现场给你出这一关的题 · 已等 {waitedSeconds}s</p>
        </>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// 结算
// ---------------------------------------------------------------------------

export function ResultScreen({
  xp,
  accuracy,
  durationMs,
  streak,
  bestCombo,
  review,
  live,
  canAskAgent,
  nextNote,
  onContinue,
}: {
  xp: number;
  accuracy: number;
  durationMs: number;
  streak: number;
  bestCombo: number;
  review: Reply | undefined;
  /** 结算点评正在写：逐字流入。 */
  live: LiveTurn | null;
  canAskAgent: boolean;
  /** 下一关出好了的那句提示（照这一关的错题出的会这么写）；还没出好是 null。 */
  nextNote: string | null;
  onContinue: () => void;
}) {
  return (
    <div className="en-result">
      <div className="en-result-body">
        <Octo mood="cheer" size={128} />
        <h3>这一关完成！</h3>
        <div className="en-stats">
          <div className="en-stat" data-tone="xp">
            <span>本关 XP</span>
            <b>
              <IconBolt size={20} />+{xp}
            </b>
          </div>
          <div className="en-stat" data-tone="acc">
            <span>正确率</span>
            <b>
              <IconTarget />
              {Math.round(accuracy * 100)}%
            </b>
          </div>
          <div className="en-stat" data-tone="time">
            <span>用时</span>
            <b>
              <IconClock />
              {formatDuration(durationMs)}
            </b>
          </div>
        </div>
        <div className="en-result-row">
          <span data-tone="fire">
            <IconFlame size={16} /> 连胜 {streak} 天
          </span>
          {bestCombo >= 2 ? (
            <span data-tone="xp">
              <IconBolt size={16} /> 最长连对 {bestCombo} 题
            </span>
          ) : null}
        </div>

        {canAskAgent ? (
          <div className="en-review">
            <span className="en-judge-agent-who">Emma 老师的点评</span>
            {review?.status === "done" && review.text ? (
              review.text
            ) : review?.status === "failed" ? (
              "老师这次没写出点评。"
            ) : live?.text ? (
              <>
                {live.text}
                <span className="m-caret" />
              </>
            ) : (
              <span className="en-dots">
                {review?.status === "running" ? "老师在看你这一关的表现" : "排队中，老师在忙上一件事"}
                <i />
                <i />
                <i />
              </span>
            )}
            {nextNote ? <div className="en-review-next">{nextNote}</div> : null}
          </div>
        ) : null}

        <p className="en-result-sub">进度只存在这台设备的浏览器里，换个浏览器就从 0 开始。</p>
      </div>
      <div className="en-result-foot">
        <button type="button" className="en-btn en-btn-primary en-btn-blue" onClick={onContinue}>
          继续
        </button>
      </div>
    </div>
  );
}
