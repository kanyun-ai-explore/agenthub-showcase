"use client";

/**
 * 关卡播放器：一屏一题。
 *
 * 学员的每个操作都在本地有即时反馈，不等 agent：选了就亮、「检查」点下去判定条和音效
 * 同一帧出来、「继续」直接进下一题（题都在本地）。agent 只在两处露面，都不挡「继续」：
 * - 答错时后台先要讲解，判定条上的「为什么」点了才显示（W2）；
 * - 跟读的语音回合：转写回来立刻画逐词比对，文字点评后到，「看点评」点了才显示（W3）。
 * 两者点开时如果还在生成，就接会话的事件流逐字显示（`live`），还在排队就显示 loading。
 *
 * 分批到的一关（冷启那一关先到 2 道）：后面的题到了就接上；第一批做完了后面的还没到，
 * 就放占位等着（阶段提示同样来自事件流）。
 *
 * 学员走到过的题不再换（`lockReached`）：草稿被拒后重调、两批并行发出、回合终态的
 * 权威结果和草稿不一样时，只有他还没看到的题会变。结算用的也是他看到的那一份（`onFinish`
 * 把它交出去），错题不会挂到别的题上。
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { VoiceTake } from "@/lib/agenthub/voice-recording";
import {
  answerText,
  correctText,
  DEFAULT_PROMPT,
  grade,
  lockReached,
  TYPE_LABEL,
  whyMessage,
  type Answer,
  type Exercise,
  type LessonContent,
} from "@/lib/course/english-lesson";
import {
  advance,
  check,
  currentIndex,
  extend,
  inRetry,
  progressRatio,
  skip,
  startPlayer,
  truncate,
  type PlayerState,
} from "@/lib/course/lesson-player";
import { compareReading } from "@/lib/course/read-aloud";
import { sfx } from "@/lib/course/sfx";
import { Octo } from "../Octo";
import { ReadAloudCard } from "../ReadAloudCard";
import { IconCheck, IconClose, IconFlame, IconSpeaker } from "./EnIcons";
import type { LessonChannel, Reply } from "./useLessonChannel";
import type { TtsSource } from "./useSpeech";

export interface Speech {
  play: (text: string) => Promise<void>;
  speaking: string | null;
  source: TtsSource | null;
}

/** 选项题的选中、拼句的词块：检查之前的那点状态。 */
type Draft = { kind: "choice"; index: number } | { kind: "tiles"; picked: number[] } | null;

const PRAISE = ["太棒了！", "答对了！", "真不错！", "完全正确！"];

/** 一关的题数（CLAUDE.md 让 agent 出 8 道）。只在后面批次未到时给进度条当分母。 */
const LESSON_SIZE = 8;

/** 事件流的阶段 → 等待时那句提示（参数生成期间没有事件，只能按阶段说）。 */
export const STAGE_HINT: Record<string, string> = {
  waiting: "老师在准备",
  start: "老师在准备",
  thinking: "老师在想这一关出什么",
  writing: "老师在想这一关出什么",
  tool: "老师在写题",
};

export function LessonPlayer({
  runId,
  content,
  channel,
  speech,
  canAskAgent,
  onFirstQuestion,
  onExit,
  onFinish,
}: {
  runId: number;
  content: LessonContent;
  channel: LessonChannel;
  speech: Speech;
  /** 会话能不能找 agent（没接上时不显示「为什么」「看点评」，只给题目自带的提示）。 */
  canAskAgent: boolean;
  /** 第一题画出来、可以作答的那一帧（「点开 → 第一题可答」的终点）。 */
  onFirstQuestion?: () => void;
  onExit: () => void;
  /** 做完了：作答记录 + 学员实际看到的那份题（错题按它对）。 */
  onFinish: (state: PlayerState<Answer>, exercises: readonly Exercise[]) => void;
}) {
  const [player, setPlayer] = useState(() =>
    startPlayer<Answer>(content.exercises.length, Date.now(), !content.complete),
  );

  // 学员走到过的题锁住，后面的位置用新来的。render 里写 ref：只增不减，同样的输入得到同样的
  // 结果，重复 render 无害。
  const lockedRef = useRef<Exercise[]>([]);
  const index = currentIndex(player);
  const locking = lockReached(lockedRef.current, content.exercises, index === null ? 0 : index + 1);
  lockedRef.current = locking.locked;
  const exercises = locking.shown;

  // 后面的批次到了（或者确定不会再来了）：接到第一遍末尾，在等的话接着答。题变少了（防御，
  // 上游本该不缩短；走到过的题有锁，不会被拿掉）就把多出的那几道拿掉，不让下标越界画空白。
  useEffect(() => {
    setPlayer((state) =>
      exercises.length < state.total
        ? truncate(state, exercises.length, Date.now())
        : extend(state, exercises.length, !content.complete, Date.now()),
    );
  }, [exercises.length, content.complete]);
  const [draft, setDraft] = useState<Draft>(null);
  const [whyOpen, setWhyOpen] = useState(false);
  const [banner, setBanner] = useState<number | null>(null);

  const exercise = index === null ? null : exercises[index];
  const attemptNo = index === null ? 0 : player.attempts[index].length;
  const lastAttempt = index === null ? undefined : player.attempts[index][attemptNo - 1];
  const checked = player.stage === "checked";

  // 讲解按「这一关 × 这道题」记：重出的那次答错，复用第一次要来的讲解。
  const explainKey = index === null ? null : `${runId}:${index}:why`;
  // 跟读每读一次是一个语音回合，点评按「这一次」记。
  const voiceKey = index === null ? null : `${runId}:${index}:${attemptNo}`;
  const feedbackKey = voiceKey ? `${voiceKey}:feedback` : null;
  const checkedVoiceKey = index === null ? null : `${runId}:${index}:${attemptNo - 1}`;

  // 结束：交给外面结算（交出去的是学员实际看到的那份题）。
  const finishedRef = useRef(false);
  useEffect(() => {
    if (player.stage !== "done" || finishedRef.current) return;
    finishedRef.current = true;
    onFinish(player, exercises);
  }, [player, onFinish, exercises]);

  // 第一题画出来的那一帧报一次（等下一帧，量到的是画出来，不只是算出来）。回调走 ref：调用方传的
  // 是内联函数，每次 render 都换身份，挂进依赖会让 cleanup 把还没触发的那一帧取消掉。
  const onFirstQuestionRef = useRef(onFirstQuestion);
  onFirstQuestionRef.current = onFirstQuestion;
  const firstReportedRef = useRef(false);
  const hasQuestion = Boolean(exercise) && player.stage === "answering";
  useEffect(() => {
    if (firstReportedRef.current || !hasQuestion) return;
    firstReportedRef.current = true;
    requestAnimationFrame(() => onFirstQuestionRef.current?.());
  }, [hasQuestion]);

  // 听音题一出来就自动念一遍（「继续」是一次点击，浏览器放行自动播放）。
  const playedRef = useRef<string | null>(null);
  useEffect(() => {
    if (!exercise || exercise.type !== "listen_choice" || player.stage !== "answering") return;
    const key = `${player.pos}`;
    if (playedRef.current === key) return;
    playedRef.current = key;
    void speech.play(exercise.audio_text);
  }, [exercise, player.pos, player.stage, speech]);

  const doCheck = useCallback(
    (answer: Answer) => {
      if (!exercise || index === null) return;
      const correct = grade(exercise, answer);
      const next = check(player, correct, answer);
      setPlayer(next);
      setWhyOpen(false);
      if (correct) sfx.correct();
      else sfx.wrong();
      if (next.milestone) {
        setBanner(next.milestone);
        setTimeout(() => sfx.combo(), 260);
      }
      // 答错：后台先把讲解要上（跟读的点评随语音回合一起来，不另要）。
      if (!correct && canAskAgent && exercise.type !== "read_aloud" && explainKey) {
        channel.prepareExplain(explainKey, whyMessage(exercise, answerText(exercise, answer), index + 1));
      }
    },
    [canAskAgent, channel, exercise, explainKey, index, player],
  );

  const doContinue = useCallback(() => {
    channel.leaveQuestion(explainKey);
    setPlayer((state) => advance(state, Date.now()));
    setDraft(null);
    setWhyOpen(false);
    setBanner(null);
  }, [channel, explainKey]);

  // 跟读：转写回来（通道里那一次语音回合的状态变成 done）就本地比对、判定。
  const voice = voiceKey ? channel.voices[voiceKey] : undefined;
  useEffect(() => {
    if (!exercise || exercise.type !== "read_aloud" || player.stage !== "answering") return;
    if (voice?.status !== "done") return;
    const transcript = voice.transcript ?? "";
    doCheck({ kind: "reading", transcript, comparison: compareReading(exercise.text, transcript) });
  }, [doCheck, exercise, player.stage, voice]);

  // 连对横幅停一会儿自己收起。
  useEffect(() => {
    if (banner === null) return;
    const timer = setTimeout(() => setBanner(null), 1800);
    return () => clearTimeout(timer);
  }, [banner]);

  // 等后面的批次；或者这一帧下标还落在没有题的位置（上面的 effect 下一帧就会收掉）——
  // 两种都画占位，留着 ✕，不返回 null 让整屏空白。
  if (player.stage === "waiting" || player.stage === "done" || !exercise || index === null) {
    // 后面的题由正在出题的那一件给（出题多半跑在第二个会话上，见 useLessonChannel 的 lessonLive）；
    // 主会话那条道上跑的可能是一条讲解，它的阶段不是这里要显示的。
    const live = channel.lessonLive;
    return (
      <div className="en-play">
        <PlayTop onExit={onExit} ratio={progressRatio(player, LESSON_SIZE)} combo={player.combo} />
        <div className="en-wait">
          <div className="en-wait-cards">
            <i />
            <i />
            <i />
          </div>
          <b className="en-dots">
            {live ? (STAGE_HINT[live.stage] ?? "老师在写题") : "后面的题马上就到"}
            <i />
            <i />
            <i />
          </b>
          <span>{player.stage === "waiting" ? `前 ${player.total} 道做完了，后面的题老师还在出。` : "这一关的题收尾中…"}</span>
        </div>
      </div>
    );
  }

  const canCheck =
    draft !== null && (draft.kind === "choice" || (draft.kind === "tiles" && draft.picked.length > 0));
  const retry = inRetry(player);
  const readingAnswer = lastAttempt?.answer.kind === "reading" ? lastAttempt.answer : null;

  return (
    <div className="en-play">
      <PlayTop onExit={onExit} ratio={progressRatio(player, LESSON_SIZE)} combo={player.combo} />

      {content.focus ? (
        <div className="en-focus">
          <b>本关重点</b>
          {content.focus}
        </div>
      ) : null}

      {banner !== null ? (
        <div className="en-banner" key={`${player.pos}-${banner}`}>
          <IconFlame size={18} />
          {banner >= 5 ? `连对 ${banner} 题！势不可挡` : `连对 ${banner} 题！`}
        </div>
      ) : null}

      <div className="en-play-body" key={player.pos}>
        <div className="en-q-kind" data-type={exercise.type}>
          {retry ? "再练一次 · " : ""}
          {TYPE_LABEL[exercise.type]}
        </div>
        <h2 className="en-q-title">{exercise.prompt ?? DEFAULT_PROMPT[exercise.type]}</h2>

        {exercise.type === "listen_choice" ? (
          <ListenChoice
            exercise={exercise}
            draft={draft}
            checked={checked ? (lastAttempt?.answer ?? null) : null}
            speech={speech}
            onPick={(i) => setDraft({ kind: "choice", index: i })}
          />
        ) : null}
        {exercise.type === "fill_blank" ? (
          <FillBlank
            exercise={exercise}
            draft={draft}
            checked={checked ? (lastAttempt?.answer ?? null) : null}
            onPick={(i) => setDraft({ kind: "choice", index: i })}
          />
        ) : null}
        {exercise.type === "word_bank" ? (
          <WordBank
            exercise={exercise}
            picked={draft?.kind === "tiles" ? draft.picked : []}
            checked={checked ? (lastAttempt?.correct ?? null) : null}
            onChange={(picked) => setDraft({ kind: "tiles", picked })}
          />
        ) : null}
        {exercise.type === "read_aloud" ? (
          <ReadAloudCard
            key={voiceKey ?? undefined}
            payload={exercise}
            status={
              checked
                ? "done"
                : voice?.status === "queued"
                  ? "queued"
                  : voice?.status === "sending"
                    ? "sending"
                    : "idle"
            }
            result={readingAnswer && checked ? { transcript: readingAnswer.transcript, comparison: readingAnswer.comparison } : null}
            error={voice?.status === "failed" ? (voice.error ?? "这次没发出去，再读一次试试。") : null}
            canRecord={canAskAgent}
            onTake={(take: VoiceTake) => {
              if (voiceKey && feedbackKey) channel.sendVoice(voiceKey, feedbackKey, take);
            }}
            onSkip={() => {
              // 录音还排着就不发了（在发的那次停不下来，回来时题已经换了，不会再用）。
              if (voiceKey) channel.skipVoice(voiceKey);
              channel.leaveQuestion(null);
              setPlayer((state) => skip(state, Date.now()));
            }}
            onPlayExample={() => void speech.play(exercise.text)}
            playingExample={speech.speaking === exercise.text}
          />
        ) : null}
      </div>

      {!checked && exercise.type !== "read_aloud" ? (
        <div className="en-play-foot">
          <button
            type="button"
            className="en-btn en-btn-check"
            disabled={!canCheck}
            onClick={() => {
              if (!draft) return;
              doCheck(draft.kind === "choice" ? { kind: "choice", index: draft.index } : { kind: "tiles", picked: draft.picked });
            }}
          >
            检查
          </button>
        </div>
      ) : null}

      {checked && lastAttempt ? (
        <JudgeBar
          exercise={exercise}
          correct={lastAttempt.correct}
          answer={lastAttempt.answer}
          praise={PRAISE[(player.pos + runId) % PRAISE.length]}
          agentButton={
            !canAskAgent
              ? null
              : exercise.type === "read_aloud"
                ? { label: "看点评", replyKey: checkedVoiceKey ? `${checkedVoiceKey}:feedback` : null }
                : !lastAttempt.correct
                  ? { label: "为什么？", replyKey: explainKey }
                  : null
          }
          channel={channel}
          open={whyOpen}
          onOpen={() => {
            setWhyOpen(true);
            if (exercise.type !== "read_aloud" && explainKey && lastAttempt) {
              channel.openExplain(explainKey, whyMessage(exercise, answerText(exercise, lastAttempt.answer), index + 1));
            }
          }}
          onContinue={doContinue}
        />
      ) : null}
    </div>
  );
}

function PlayTop({ onExit, ratio, combo }: { onExit: () => void; ratio: number; combo: number }) {
  return (
    <div className="en-play-top">
      <button type="button" className="en-close" onClick={onExit} aria-label="退出这一关">
        <IconClose />
      </button>
      <div className="en-bar">
        <span className="en-bar-fill" style={{ width: `${Math.round(ratio * 100)}%` }} />
      </div>
      {combo >= 2 ? (
        <span className="en-combo">
          <IconFlame size={18} />
          {combo}
        </span>
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------------------
// 判定条
// ---------------------------------------------------------------------------

function JudgeBar({
  exercise,
  correct,
  answer,
  praise,
  agentButton,
  channel,
  open,
  onOpen,
  onContinue,
}: {
  exercise: Exercise;
  correct: boolean;
  answer: Answer;
  praise: string;
  agentButton: { label: string; replyKey: string | null } | null;
  channel: LessonChannel;
  open: boolean;
  onOpen: () => void;
  onContinue: () => void;
}) {
  const reading = answer.kind === "reading" ? answer.comparison : null;
  const title = reading
    ? correct
      ? "读得很完整！"
      : `${reading.right} / ${reading.total} 读对${reading.extra.length > 0 ? `，多读了「${reading.extra.join(" ")}」` : ""}`
    : correct
      ? praise
      : "正确答案：";
  const detail = correct ? exercise.explain : exercise.hint;
  const reply: Reply | undefined = agentButton?.replyKey ? channel.replies[agentButton.replyKey] : undefined;
  const live = channel.live && agentButton?.replyKey && channel.live.replyKey === agentButton.replyKey ? channel.live : null;
  const loading = !reply || reply.status === "queued" || reply.status === "running";

  return (
    <div className="en-judge" data-correct={correct}>
      <div className="en-judge-head">
        <span className="en-judge-icon">{correct ? <IconCheck size={18} stroke={4} /> : <IconClose />}</span>
        <b>{title}</b>
      </div>
      {!correct && !reading ? <div className="en-judge-answer">{correctText(exercise)}</div> : null}
      {detail ? <div className="en-judge-detail">{correct ? detail : `提示：${detail}`}</div> : null}

      {agentButton && open ? (
        <div className="en-judge-agent">
          <span className="en-judge-agent-who">Emma 老师</span>
          {reply?.status === "done" ? (
            reply.text
          ) : reply?.status === "failed" || reply?.status === "dropped" ? (
            "这次老师没讲出来，先看上面的提示吧。"
          ) : live && live.text ? (
            <>
              {live.text}
              <span className="m-caret" />
            </>
          ) : (
            <span className="en-dots">
              {reply?.status === "running" ? "老师在想" : "排队中，老师在忙上一件事"}
              <i />
              <i />
              <i />
            </span>
          )}
        </div>
      ) : null}

      <div className="en-judge-actions">
        {agentButton && !open ? (
          <button type="button" className="en-btn en-btn-ghost" data-loading={loading} onClick={onOpen}>
            {loading ? <span className="en-spin" /> : null}
            {agentButton.label}
          </button>
        ) : null}
        <button type="button" className="en-btn en-btn-continue" onClick={onContinue}>
          继续
        </button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// 三类点选题
// ---------------------------------------------------------------------------

function optionState(i: number, answerIndex: number, draft: Draft, checked: Answer | null): string {
  if (checked && checked.kind === "choice") {
    if (i === answerIndex) return "right";
    if (i === checked.index) return "wrong";
    return "idle";
  }
  return draft?.kind === "choice" && draft.index === i ? "selected" : "idle";
}

function ListenChoice({
  exercise,
  draft,
  checked,
  speech,
  onPick,
}: {
  exercise: Extract<Exercise, { type: "listen_choice" }>;
  draft: Draft;
  checked: Answer | null;
  speech: Speech;
  onPick: (index: number) => void;
}) {
  return (
    <div className="en-q">
      <div className="en-listen en-scene">
        <Octo mood="idle" size={96} />
        <div className="en-bubble">
          <button
            type="button"
            className="en-speaker"
            data-playing={speech.speaking === exercise.audio_text}
            onClick={() => void speech.play(exercise.audio_text)}
            aria-label="再听一遍"
          >
            <IconSpeaker size={44} />
          </button>
        </div>
      </div>
      {speech.source === "browser" ? <div className="en-tts-tag">本机语音（平台读音这次没取到）</div> : null}
      <div className="en-options">
        {exercise.options.map((option, i) => (
          <button
            key={`${i}-${option}`}
            type="button"
            className="en-opt"
            data-state={optionState(i, exercise.answer_index, draft, checked)}
            disabled={checked !== null}
            onClick={() => onPick(i)}
          >
            {option}
          </button>
        ))}
      </div>
    </div>
  );
}

function FillBlank({
  exercise,
  draft,
  checked,
  onPick,
}: {
  exercise: Extract<Exercise, { type: "fill_blank" }>;
  draft: Draft;
  checked: Answer | null;
  onPick: (index: number) => void;
}) {
  const [before, after] = exercise.sentence.split("___");
  const shown = checked ? exercise.answer_index : draft?.kind === "choice" ? draft.index : null;
  return (
    <div className="en-q">
      <div className="en-sentence">
        <span>{before}</span>
        <span className="en-blank" data-filled={shown !== null} data-final={checked !== null}>
          {shown !== null ? exercise.options[shown] : ""}
        </span>
        <span>{after ?? ""}</span>
      </div>
      <div className="en-options en-options-row">
        {exercise.options.map((option, i) => (
          <button
            key={`${i}-${option}`}
            type="button"
            className="en-opt en-opt-word"
            data-state={optionState(i, exercise.answer_index, draft, checked)}
            disabled={checked !== null}
            onClick={() => onPick(i)}
          >
            {option}
          </button>
        ))}
      </div>
    </div>
  );
}

function WordBank({
  exercise,
  picked,
  checked,
  onChange,
}: {
  exercise: Extract<Exercise, { type: "word_bank" }>;
  picked: number[];
  /** 检查过了：整句对 / 错；还没检查是 null。 */
  checked: boolean | null;
  onChange: (picked: number[]) => void;
}) {
  const used = useMemo(() => new Set(picked), [picked]);
  const locked = checked !== null;
  return (
    <div className="en-q">
      <div className="en-tray" data-empty={picked.length === 0}>
        {picked.length === 0 ? (
          <span className="en-tray-hint">点下面的词，把它们排成一句话</span>
        ) : (
          picked.map((i) => (
            <button
              key={`${i}-${exercise.bank[i]}`}
              type="button"
              className="en-tile"
              data-state={locked ? (checked ? "right" : "wrong") : "placed"}
              disabled={locked}
              onClick={() => onChange(picked.filter((p) => p !== i))}
            >
              {exercise.bank[i]}
            </button>
          ))
        )}
      </div>
      <div className="en-bank">
        {exercise.bank.map((word, i) => (
          <button
            key={`${i}-${word}`}
            type="button"
            className="en-tile"
            data-state={used.has(i) ? "used" : "idle"}
            disabled={locked || used.has(i)}
            onClick={() => onChange([...picked, i])}
          >
            {word}
          </button>
        ))}
      </div>
    </div>
  );
}
