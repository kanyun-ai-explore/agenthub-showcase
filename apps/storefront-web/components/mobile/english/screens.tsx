"use client";

/**
 * 英语小课的三块非答题界面：路径图、等题、结算。
 *
 * 等待都给看得见的反馈：路径图底部一行写着 agent 这会儿在干什么（会话启动中 / 在按错题出单元 3 /
 * 已备好）；等题界面（只有单元 3 会等）按事件流的阶段换提示；结算屏的数字本地立刻出来，单元点评
 * 随后流入，单元 3 那一关的出题进度也写在结算屏上。
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
const OFFSETS = [0, 48, 0, -48, 0];

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
                const offset = OFFSETS[levelIndex % OFFSETS.length];
                // 每个单元的最后一关是单元结算（单元点评），画成奖杯。
                const trophy = levelIndex === unit.levels.length - 1;
                return (
                  <div className="en-node-row" key={level.id} style={{ transform: `translateX(${offset}px)` }}>
                    {isCurrent ? (
                      <div className="en-node-tip">
                        {status === "running" || status === "queued" ? "正在按你的错题生成…" : "开始"}
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
  hasMistakes,
  problem,
  onBack,
  onRetry,
}: {
  stop: PathStop;
  status: LessonStatus;
  live: LiveTurn | null;
  waitedSeconds: number;
  /** 有没有错题：没有就照单元 1、2 的语法点出综合练习，提示语跟着换。 */
  hasMistakes: boolean;
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
          <p className="en-loading-sub">
            {hasMistakes ? "正在根据你的错题生成" : "你还没有错题，按单元 1、2 的语法点出综合练习"} · 已等 {waitedSeconds}s
          </p>
        </>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// 结算
// ---------------------------------------------------------------------------

/** 结算屏上单元 3 那一关的出题进度（单元 1、2 每做完一关就出或重出一关）。 */
export interface GenerationNote {
  /** 单元 3 那一关的标题。 */
  title: string;
  state: "working" | "ready" | "failed";
  /** 是照错题出的，还是没有错题、出的综合练习。 */
  withMistakes: boolean;
}

export function ResultScreen({
  xp,
  accuracy,
  durationMs,
  streak,
  bestCombo,
  review,
  live,
  showReview,
  generation,
  onContinue,
}: {
  xp: number;
  accuracy: number;
  durationMs: number;
  streak: number;
  bestCombo: number;
  review: Reply | undefined;
  /** 单元点评正在写：逐字流入。 */
  live: LiveTurn | null;
  /** 单元的最后一关才有单元点评，其余各关的结算屏只有本地数字。 */
  showReview: boolean;
  generation: GenerationNote | null;
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

        {showReview ? (
          <div className="en-review">
            <span className="en-judge-agent-who">Emma 老师的单元点评</span>
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
                {review?.status === "running" ? "老师在看你这个单元的表现" : "排队中，老师在忙上一件事"}
                <i />
                <i />
                <i />
              </span>
            )}
          </div>
        ) : null}

        {generation ? (
          <div className="en-review en-review-next" data-state={generation.state}>
            {generation.state === "working"
              ? `单元 3「${generation.title}」正在后台${generation.withMistakes ? "按你的错题" : "按单元 1、2 的语法点"}出题`
              : generation.state === "ready"
                ? `单元 3「${generation.title}」已经${generation.withMistakes ? "按你的错题" : "按单元 1、2 的语法点"}出好`
                : `单元 3「${generation.title}」这次没出成，打开它时会再出一次`}
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
