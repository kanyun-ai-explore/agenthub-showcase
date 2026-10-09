"use client";

/**
 * 情景对话（Roleplay）：咖啡店。页面骨架沿用英语小课的课程页，但这一节练的是**对话**——
 * 店员（一个 `format: live` 的 agent）先说一句，学员按住按钮用英语回一句，来回 3–4 轮，
 * 最后出一张小结卡。
 *
 * 三处与一/二期的课不同：
 * - **agent 是 live 的**：不建沙箱、不调工具，回复快；但也因此**小结卡只能前端算**
 *   （`lib/course/roleplay-summary.ts`），不靠 `present_*`。
 * - **每一句店员的话都会被合成成音频**（`voice.output`），页面在它到的时候自动播一遍，
 *   每条还留一个 🔊 供重听——对讲机的听感靠这个，不是靠文字。
 * - **录音这一台与跟读卡共用**（`useVoiceTake`）：按住说话、松手就发、每分钟 10 次、
 *   单段 55 s 自己收尾（平台上限 60 s）/ 2 MB，都是同一份实现与同一套提示。
 *
 * 无沙箱 = 没有「沙箱就绪」那一段等待，所以这里的开场按钮点下去直接就进对话。
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { EMPTY_TRANSCRIPT_TEXT, type Conversation } from "@/components/agent/useAgentConversation";
import { playSegmentOn, readTurnAudioOnce } from "@/lib/agenthub/turn-audio-client";
import { startTurnAudioPlayback, type Playback, type PlaybackOutcome } from "@/lib/agenthub/turn-audio-player";
import { buildTurnTimingReport, type TurnTimingMark } from "@/lib/agenthub/turn-timing";
import { foldRoleplayScript, type ScriptTurn } from "@/lib/course/roleplay-script";
import { summarizeRoleplay, type RoleplayRound } from "@/lib/course/roleplay-summary";
import { finishRoleplay, readRoleplay, type RoleplayProgress } from "@/lib/showcase/progress";
import { EnStatusBar } from "./english/EnIcons";
import { Octo } from "./Octo";
import { useVoiceTake } from "./useVoiceTake";

/** 一节课的轮数：第 3 轮起可以提前收，最多到 4 轮。 */
const MAX_ROUNDS = 4;
const EARLY_EXIT_ROUND = 3;

/** 每轮的「参考说法」：页面自己写的脚手架（不是 agent 的话），卡住时看一眼。 */
const ROUND_HINTS = [
  "试着说：I would like a coffee, please.",
  "试着说：Hot, please. / Iced, please.",
  "试着说：No, thank you. / Yes, a cake, please.",
  "试着说：Here you are. Thank you!",
];

/**
 * 一个语音回合在客户端的时刻（`performance.now()`）。松手时开，终态与音频都收尾了就上报一次
 * （`/api/agenthub/turn-timing`，口径见 `lib/agenthub/turn-timing.ts`）。
 */
interface TurnClock {
  sessionId: string | null;
  turnId: string | null;
  /** 松手的 epoch ms。 */
  t0: number;
  at: Partial<Record<TurnTimingMark, number>>;
  audio: { reads?: number; played?: number; skipped?: number };
  settled: boolean;
  audioDone: boolean;
  reported: boolean;
  /** 这一句回复当前的那次播放（补播、或学员点它自己的 🔊 之后换成新的那次；终态时 `settle` 打到它身上）。 */
  playback: Playback | null;
}

export function RoleplayApp({
  conversation,
  openers,
  visitorId,
  sceneTitle = "咖啡店",
  clerkName = "Sam",
  welcomeText = "你走进一家咖啡店，店员 Sam 在柜台后面。点一下开始，他会先跟你打招呼。",
}: {
  conversation: Conversation;
  openers: string[];
  /** 完成次数按这个身份分键（localStorage）；还没拿到身份时读写都空转。 */
  visitorId: string | null;
  sceneTitle?: string;
  clerkName?: string;
  welcomeText?: string;
}) {
  /** 开场那句是页面替学员说的，不算他的一轮。 */
  const opener = openers[0] ?? "开始点单";
  const [progress, setProgress] = useState<RoleplayProgress>({ conversations: 0 });
  const [summaryOpen, setSummaryOpen] = useState(false);
  const [awarded, setAwarded] = useState<RoleplayProgress | null>(null);
  const [playingTurnId, setPlayingTurnId] = useState<string | null>(null);
  const [audioNote, setAudioNote] = useState<string | null>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  /** 已经自动播过的 turnId：同一句不因为重渲染再播一遍。 */
  const playedRef = useRef<Set<string>>(new Set());

  useEffect(() => {
    setProgress(readRoleplay(visitorId));
  }, [visitorId]);

  useEffect(
    () => () => {
      audioRef.current?.pause();
    },
    [],
  );

  // ── 对话稿：从消息里折出来（店员的话 / 学员的转写各成一条） ─────────────────
  //
  // 店员那句**边到边显示**：SSE 的正文 delta 一到就出现在气泡里（`streaming`），终态到了整句
  // 替换。折叠规则（对齐、流断了怎么回落）在 `lib/course/roleplay-script.ts`。
  const turns = useMemo<ScriptTurn[]>(() => foldRoleplayScript(conversation.messages, opener), [conversation.messages, opener]);
  /** 正在流式出字的那一句（只有一个回合在飞）。 */
  const streamingText = conversation.messages.find((m) => m.role === "agent" && m.streaming && m.text.trim())?.text ?? "";

  const studentTurns = turns.filter((t) => t.role === "student").length;
  const round = Math.min(studentTurns + 1, MAX_ROUNDS);

  /** 小结卡的口径：每一轮学员说完之后店员回的那一句。 */
  const summary = useMemo(() => summarizeRoleplay(pairRounds(turns)), [turns]);

  const started = conversation.messages.length > 0;

  /**
   * 最近一次「要播某一句」的发起（每次发起一个新的令牌，不用 turnId：同一句连点两次 🔊 是两次
   * 发起）。**每一次发起都要先在这里记一笔**，回来的东西对不上就整段丢掉——这条与跟读卡
   * `latestTurnRef` 是同一类问题：
   *
   * 读音频是轮询（`turn-audio-player.ts`，最长 30 s）。这段时间里学员完全可以录下一句
   * ——店员回话、页面自动播新一轮；上一轮那次播放若还在跑，就会在**同一个 audioRef** 上
   * 把新一轮盖掉，或者两段叠着播。所以新一次发起先取消上一次（`playbackRef`），收尾时
   * 再核一遍这里，作废的那次不动提示、不动指示灯。重听按钮按下的那一刻算一次新发起。
   */
  const latestPlayRef = useRef<object | null>(null);
  /** 当前这一次播放。新一次发起、按住说话、卸载时取消它。 */
  const playbackRef = useRef<Playback | null>(null);
  /**
   * 手指还按在「按住说话」上（含 `getUserMedia` 等权限的那一段）。这期间**任何播放都不许
   * 开始**——自动播、🔊 重听（触屏上第二根手指点得到）、晚到的读取都走 `playTurn`，闸就设在
   * 它的入口这一处。已经在放的那句由按下时的 `stopPlayback` 停掉。两件合起来才是半双工。
   */
  const holdingRef = useRef(false);
  /** 最近一次松手的 `performance.now()`（按下时清掉）。 */
  const releasedAtRef = useRef<number | null>(null);
  /** 在飞的那个语音回合的时刻表；终态之后清掉（上报由它自己收尾）。 */
  const clockRef = useRef<TurnClock | null>(null);

  /** 组件还在。卸载时的取消不许触发补播（严格模式下 effect 会跑两遍，所以在正文里置回 true）。 */
  const aliveRef = useRef(true);
  useEffect(() => {
    aliveRef.current = true;
    return () => {
      aliveRef.current = false;
      playbackRef.current?.cancel();
    };
  }, []);

  /** 终态与音频都收尾了才报，一回合只报一次；报不出去不重试（这是读数，不是业务）。 */
  const reportClock = useCallback((clock: TurnClock) => {
    if (clock.reported || !clock.settled || !clock.audioDone || !clock.turnId || !clock.sessionId) return;
    clock.reported = true;
    const body = buildTurnTimingReport({
      sessionId: clock.sessionId,
      turnId: clock.turnId,
      t0: clock.t0,
      at: clock.at,
      audio: clock.audio,
    });
    void fetch("/api/agenthub/turn-timing", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      keepalive: true,
    }).catch(() => undefined);
  }, []);

  /**
   * 回复的自动播放欠着的那一句。语音回合的播放在 voice-turn 回包时就起跑，
   * 等回复的这几秒里它会被别的动作打断：点上一句的 🔊、录满 55 s 自动收尾时手指还按着。
   * 改前播放到终态才起跑，这些动作碰不到它。所以：出声之前被打断（不是学员按住说下一句）
   * 就记在这里，等手上没有别的播放、手指也松开了再补一次——别的播放收尾时、回合终态时、
   * 松手时各查一次。点的正是这一句的 🔊，就由那一次接过去（`playTurn`），不再补。学员按住说
   * 下一句时（`stopPlayback`），欠着的那句就不补了，时刻照样上报。
   */
  const owedRef = useRef<TurnClock | null>(null);
  /** 被按住说话打断的播放：这类取消是学员的本意，不补。 */
  const heldOffRef = useRef<WeakSet<Playback>>(new WeakSet());
  /**
   * 音频还没收尾的那一句回复的时刻表（自动播放在读 / 在放，或者欠着）。`clockRef` 到终态就
   * 清掉了，而回复的 🔊 正是终态那一刻才出现：点它的时候靠这里找回时刻表。
   */
  const replyClockRef = useRef<TurnClock | null>(null);

  /**
   * 一句回复的音频这一路收尾：不再补播，时刻照实上报（终态还没到的话，终态那一步再报）。
   * 收尾只走这一处：放完、被按住说话打断、欠着时学员按住说下一句、起不了跑也补不了。
   */
  const finishReplyAudio = useCallback(
    (clock: TurnClock) => {
      if (owedRef.current === clock) owedRef.current = null;
      if (replyClockRef.current === clock) replyClockRef.current = null;
      clock.audioDone = true;
      reportClock(clock);
    },
    [reportClock],
  );

  // ── 店员这句话的音频：段 0 一就绪就开始播，也可以按 🔊 重听 ──────────────────
  //
  // 语音回合在 voice-turn 回包（turnId 到手）时就起跑，不等回合终态；开场句与重听在终态
  // 之后起跑。排段、跳过失败段、什么时候停，都在 `lib/agenthub/turn-audio-player.ts`。
  const playTurn = useCallback(
    // 默认（🔊 重听）= 回合早就终态了。
    (turnId: string, options: { settled: boolean; clock?: TurnClock } = { settled: true }): Playback | null => {
      const sessionId = conversation.sessionId;
      // 起不了跑（手指按着、会话没了）交回 null，回复那一路由调用方决定欠着还是收尾。
      if (!sessionId || holdingRef.current || !aliveRef.current) return null;
      // 点的正是还没出声的那句回复的 🔊：这一次接过它的时刻表，欠着的那笔
      // 就此销掉——不然这次放完还会再补放一遍。时刻各记第一次（`markOnce`），所以 `playStart`
      // 记的是这句第一次出声。已经出过声的，🔊 就是普通的重听，不接。
      const pending = replyClockRef.current;
      const adopted =
        !options.clock && pending?.turnId === turnId && pending.at.playStart === undefined ? pending : undefined;
      const clock = options.clock ?? adopted;
      // 接过来的这一次照回合的实际状态起跑：终态没到，就等 `onTake` 把终态交给它（`clock.playback`）。
      const settled = adopted ? adopted.settled : options.settled;
      if (adopted && owedRef.current === adopted) owedRef.current = null;
      playbackRef.current?.cancel();
      const launch = {};
      latestPlayRef.current = launch;
      setAudioNote(null);
      // 新一次发起就把「正在播…」收掉：上一次那条已经没有指示灯的主人了。
      setPlayingTurnId(null);
      const isCurrent = () => latestPlayRef.current === launch;
      const markOnce = (mark: TurnTimingMark) => {
        if (clock && clock.at[mark] === undefined) clock.at[mark] = performance.now();
      };
      const element = audioRef.current ?? new Audio();
      audioRef.current = element;
      const playback = startTurnAudioPlayback(
        {
          read: () => readTurnAudioOnce(sessionId, turnId),
          play: (segment, signal) =>
            playSegmentOn(element, segment, signal, {
              onCanPlay: (index) => {
                if (index === 0) markOnce("seg0CanPlay");
              },
              onPlaying: () => {
                markOnce("playStart");
                if (isCurrent()) setPlayingTurnId(turnId);
              },
            }),
          sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
          now: () => performance.now(),
        },
        {
          settled,
          onSegmentReady: (index) => {
            if (index === 0) markOnce("seg0Ready");
          },
        },
      );
      playbackRef.current = playback;
      if (clock) clock.playback = playback;
      void playback.done.then((outcome) => {
        // 读的次数每一次都并上。其余只归 `clock.playback` 那一次：这句被它自己的 🔊 接过去之后，
        // 被取消的这次既不记欠着、也不收尾上报，由接过去的那次收尾。
        if (clock) clock.audio.reads = (clock.audio.reads ?? 0) + outcome.reads;
        if (clock && clock.playback === playback) {
          clock.audio.played = outcome.played.length;
          clock.audio.skipped = outcome.skipped.length;
          // 回复还没出声就被取消了（等回复时点了上一句的 🔊 之类），而且不是学员按住说下一句：
          // 这一句欠着，等别的播放收尾 / 回合终态 / 松手时补播，不算收尾。
          if (outcome.status === "cancelled" && clock.at.playStart === undefined && !heldOffRef.current.has(playback)) {
            owedRef.current = clock;
          } else {
            finishReplyAudio(clock);
          }
        }
        if (playbackRef.current === playback) playbackRef.current = null;
        resumeOwedRef.current();
        // 这次已经作废了（学员又说了下一句、或又点了一次重听）：不提示，也不动播放状态
        // （否则会把正在播的那一句的状态一起清掉）。
        if (!isCurrent()) return;
        setPlayingTurnId(null);
        const note = playbackNote(outcome);
        if (note) setAudioNote(note);
      });
      return playback;
    },
    [conversation.sessionId, finishReplyAudio],
  );

  /**
   * 按住说话的那一刻把店员的声音停掉（半双工：同一时刻只有一方在说）。不停的话，店员那句
   * 还在扬声器里放——或者还在轮询、段到了才开始放——就会被录进学员这段，转写把店员的原话
   * 当成学员说的交给 agent，小结卡也会把它数成学员的词和句型。
   * 置空 `latestPlayRef`、取消当前这次播放（读不再起、段不再放、被打断的那段不再回报事件）。
   * 想再听，按 🔊。
   */
  const stopPlayback = useCallback(() => {
    latestPlayRef.current = null;
    // 学员要说下一句了：被打断的那句不再补播（想听按 🔊）。
    const current = playbackRef.current;
    if (current) heldOffRef.current.add(current);
    // 欠着的那句也不补了，但它这一回合的时刻照样报上去（早先在这里清掉就不报了）。
    const owed = owedRef.current;
    if (owed) finishReplyAudio(owed);
    current?.cancel();
    playbackRef.current = null;
    audioRef.current?.pause();
    setPlayingTurnId(null);
  }, [finishReplyAudio]);

  const startReplyAudio = useCallback(
    (clock: TurnClock) => {
      if (!clock.turnId) return;
      if (playTurn(clock.turnId, { settled: clock.settled, clock })) return;
      // 起不了跑：手指还按着（录满 55 s 自动收尾）就先欠着，松手时补；会话没了、页面卸载了，
      // 就不会再有补播的机会，照实收尾上报（早先塞回欠着就再没人管）。
      if (holdingRef.current) owedRef.current = clock;
      else finishReplyAudio(clock);
    },
    [playTurn, finishReplyAudio],
  );

  const resumeOwed = useCallback(() => {
    const clock = owedRef.current;
    if (!clock || holdingRef.current || playbackRef.current || !aliveRef.current) return;
    owedRef.current = null;
    startReplyAudio(clock);
  }, [startReplyAudio]);
  /** `playTurn` 的收尾里要叫它，而它又依赖 `playTurn`：经 ref 取最新的一份。 */
  const resumeOwedRef = useRef(resumeOwed);
  resumeOwedRef.current = resumeOwed;

  // 店员的新台词有了 turnId 就自动播（开场句走这一条；语音回合在 onTake 里已经起跑、记过
  // `playedRef`）。浏览器的自动播放策略要求先有用户手势——开场按钮那次点击就是手势，所以
  // 从第一句起就放得出来。
  const latestBarista = [...turns].reverse().find((t) => t.role === "barista" && t.turnId);
  useEffect(() => {
    if (!latestBarista?.turnId) return;
    if (playedRef.current.has(latestBarista.turnId)) return;
    playedRef.current.add(latestBarista.turnId);
    playTurn(latestBarista.turnId, { settled: true });
  }, [latestBarista, playTurn]);

  // 首个正文画到页面上的那一刻：记一笔，并叫音频那边立刻读一次（合成在首个正文时触发）。
  const hasStreamingText = streamingText !== "";
  useEffect(() => {
    if (!hasStreamingText) return;
    const clock = clockRef.current;
    if (!clock || clock.settled || clock.at.firstText !== undefined) return;
    clock.at.firstText = performance.now();
    playbackRef.current?.wake();
  }, [hasStreamingText]);

  useEffect(() => {
    stageRef.current?.scrollTo({ top: stageRef.current.scrollHeight, behavior: "smooth" });
  }, [turns.length, streamingText.length]);

  // ── 录音：一段音 → 一轮语音回合 ─────────────────────────────────────────────
  const voice = useVoiceTake({
    disabled: conversation.busy || summaryOpen,
    sessionId: conversation.sessionId,
    rateLimitedNotice: "一分钟里最多说 10 次，歇一小会儿再来。",
    holdHint: "按住按钮别松手，把整句说完再松。",
    tooShortNotice: "这一下太短了，按住按钮把整句说完再松手。",
    onTake: async (take) => {
      // 55 s 自动收尾那种没有松手事件，就从交出录音这一刻算。
      const releasedAt = releasedAtRef.current ?? performance.now();
      releasedAtRef.current = null;
      // 上一句还欠着的话，按下时的 `stopPlayback` 已经把它收尾上报了，这里不用再管。
      const clock: TurnClock = {
        sessionId: conversation.sessionId,
        turnId: null,
        t0: performance.timeOrigin + releasedAt,
        at: { release: releasedAt },
        audio: {},
        settled: false,
        audioDone: false,
        reported: false,
        playback: null,
      };
      clockRef.current = clock;
      const outcome = await conversation.sendVoice(take);
      if (!outcome.ok) {
        if (clockRef.current === clock) clockRef.current = null;
        return outcome.error ?? "这次没发送成功，再试一次。";
      }
      clock.at.uploaded = performance.now();
      clock.turnId = outcome.turnId ?? null;
      // 音频不等终态：turnId 一到就开始读，段 0 到了就放。手指还按着（录满 55 s 自动收尾）
      // 就先欠着，松手时补。
      if (clock.turnId) {
        playedRef.current.add(clock.turnId);
        replyClockRef.current = clock;
        startReplyAudio(clock);
      } else {
        clock.audioDone = true;
      }
      // 学员这句话也会被另存成一条 user 消息（转写），对话稿从那里长出来。
      // 语音回合分两段到：转写在派发后就回来，店员那句另外到（`reply`）。等它落定再收尾——
      // 不然「Sam 正在听…」提前熄掉，第 4 轮还没听到店员道别，小结卡就先盖上来了。
      const reply = await outcome.reply;
      clock.at.settled = performance.now();
      clock.settled = true;
      // 没拿到结论（`reply` 缺席）≠ 回合失败：照常等音频，只有明确失败才停读。
      const ok = reply ? reply.ok : true;
      clock.playback?.settle(ok);
      if (owedRef.current === clock) {
        if (ok) resumeOwed();
        // 回合失败：没有音频可补。
        else finishReplyAudio(clock);
      }
      reportClock(clock);
      if (clockRef.current === clock) clockRef.current = null;
      if (studentTurns + 1 >= MAX_ROUNDS) setSummaryOpen(true);
      return null;
    },
  });

  // 收尾：小结卡一出就把这一次记进本机（`awarded` 是去重闸，不是显示值）。
  useEffect(() => {
    if (!summaryOpen || awarded) return;
    const next = finishRoleplay(visitorId);
    setAwarded(next);
    setProgress(next);
  }, [summaryOpen, awarded, visitorId]);

  const releaseHold = () => {
    // pointerup 之后还会来一次 pointerleave：只认按着时的那一下。
    if (holdingRef.current) releasedAtRef.current = performance.now();
    holdingRef.current = false;
    voice.release();
    resumeOwed();
  };
  /** 按钮灰着：会话没就绪、回合在飞、录音在发。 */
  const holdDisabled = conversation.busy || voice.phase === "sending" || !conversation.sessionId;

  const startedOnce = turns.length > 0;
  const holdLabel = voice.recording
    ? `松开发送 · ${Math.round(voice.elapsedMs / 1000)}s`
    : voice.phase === "sending"
      ? `${clerkName} 正在听…`
      : "🎙 按住说话";

  return (
    <div className="m-app en-app">
      <EnStatusBar />
      <div className="en-top">
        <div className="en-bar">
          <span
            className="en-bar-fill"
            style={{ width: `${(Math.min(studentTurns, MAX_ROUNDS) / MAX_ROUNDS) * 100}%` }}
          />
        </div>
        <div className="en-hud">
          <span className="en-hud-item" data-tone="fire" title="这场对话的轮次">
            ☕ {Math.min(round, MAX_ROUNDS)} / {MAX_ROUNDS} 轮
          </span>
        </div>
      </div>

      <div className="rp-stage" ref={stageRef}>
        {!started ? (
          <div className="rp-welcome">
            <Octo mood="idle" size={104} />
            <h3>☕ {sceneTitle}</h3>
            <p>{welcomeText}</p>
            <div className="rp-openers">
              {openers.map((text) => (
                <button key={text} type="button" className="rp-opener" onClick={() => conversation.send(text)}>
                  {text}
                </button>
              ))}
            </div>
          </div>
        ) : null}

        {turns.map((turn, index) => (
          <div className="rp-turn" key={`${index}-${turn.role}`} data-role={turn.role}>
            <div className="rp-bubble">
              <span className="rp-who">{turn.role === "barista" ? `${clerkName}（店员）` : "你"}</span>
              <p>{turn.text}</p>
              {turn.role === "barista" && turn.turnId ? (
                <button
                  type="button"
                  className="rp-replay"
                  disabled={voice.recording}
                  data-playing={playingTurnId === turn.turnId}
                  onClick={() => void playTurn(turn.turnId as string)}
                >
                  {playingTurnId === turn.turnId ? "🔊 正在播放…" : "🔊 再听一遍"}
                </button>
              ) : null}
            </div>
          </div>
        ))}

        {audioNote ? <div className="en-read-notice">{audioNote}</div> : null}
        {conversation.error ? (
          <div className="rp-explain" data-correct="false">
            {conversation.error}
          </div>
        ) : null}
      </div>

      {!summaryOpen ? (
        <div className="rp-floor">
          {startedOnce && conversation.phase === "ready" ? (
            <div className="rp-hint">
              <b>参考说法</b>
              {ROUND_HINTS[Math.min(studentTurns, ROUND_HINTS.length - 1)]}
            </div>
          ) : null}
          {startedOnce && studentTurns >= EARLY_EXIT_ROUND ? (
            <button type="button" className="en-btn" onClick={() => setSummaryOpen(true)} disabled={conversation.busy}>
              聊得差不多了，看小结卡 →
            </button>
          ) : null}
          <button
            type="button"
            className="en-hold"
            data-recording={voice.recording}
            disabled={holdDisabled}
            onPointerDown={(event) => {
              event.preventDefault();
              // 灰着的按钮也收得到 pointerdown（实测）：那时既不算按住，也不许停掉
              // 店员的声音——等回复的那几秒里点一下就把这一句的自动播放打掉了。
              if (holdDisabled) return;
              holdingRef.current = true;
              releasedAtRef.current = null;
              stopPlayback();
              voice.press();
            }}
            onPointerUp={releaseHold}
            onPointerCancel={releaseHold}
            onPointerLeave={releaseHold}
            onContextMenu={(event) => event.preventDefault()}
          >
            <span className="en-hold-dot" />
            {holdLabel}
          </button>
          {voice.notice ? <div className="en-read-notice">{voice.notice}</div> : null}
          {voice.error ? (
            <div className="rp-explain" data-correct="false">
              {voice.error}
            </div>
          ) : null}
        </div>
      ) : null}

      {summaryOpen ? (
        <div className="rp-summary">
          <Octo mood="cheer" size={96} />
          <h3>这杯咖啡点完了！</h3>
          <p className="rp-summary-sub">
            你和 {clerkName} 聊了 {summary.studentTurns} 句
            {summary.missedTurns > 0 ? `（还有 ${summary.missedTurns} 句他没听清）` : ""}
            ，一共说了 {summary.spokenWords} 个英文词。
          </p>

          <div className="rp-sum-block">
            <b>你用上的句型</b>
            {summary.patterns.length > 0 ? (
              <div className="rp-chips">
                {summary.patterns.map((pattern) => (
                  <span className="rp-chip" key={pattern.phrase}>
                    {pattern.phrase}
                    <i>{pattern.gloss}</i>
                  </span>
                ))}
              </div>
            ) : (
              <p className="rp-sum-empty">这一轮没听出熟悉的句型，再聊一次试试？</p>
            )}
          </div>

          {summary.words.length > 0 ? (
            <div className="rp-sum-block">
              <b>你点到的词</b>
              <div className="rp-chips">
                {summary.words.map((word) => (
                  <span className="rp-chip rp-chip-word" key={word}>
                    {word}
                  </span>
                ))}
              </div>
            </div>
          ) : null}

          {summary.longest ? (
            <div className="rp-sum-block">
              <b>说得最长的一句</b>
              <p className="rp-longest">{summary.longest}</p>
            </div>
          ) : null}

          <div className="rp-sum-block">
            <b>刚才的对话</b>
            <div className="rp-transcript">
              {turns.map((turn, index) => (
                <p key={`s-${index}-${turn.role}`} data-role={turn.role}>
                  <span>{turn.role === "barista" ? clerkName : "你"}</span>
                  {turn.text}
                </p>
              ))}
            </div>
          </div>

          <p className="rp-summary-sub">
            小结只看你说了什么，不打分，也不评发音（转写会自动把读音纠正成正确的词，发音评不准）。
            {progress.conversations > 1 ? `这台设备上你已经聊完 ${progress.conversations} 次了。` : ""}
          </p>
          <button type="button" className="en-btn en-btn-primary" onClick={() => window.location.reload()}>
            再来一次
          </button>
        </div>
      ) : null}

      {conversation.phase === "unconfigured" ? (
        <div className="rp-floor">
          <div className="rp-explain" data-correct="false">
            这个视角的 Agent 还没配置（缺少 AGENTHUB_ROLEPLAY_AGENT_ID）。
          </div>
        </div>
      ) : null}

      {!summaryOpen && startedOnce ? (
        <div className="en-read-limit rp-limit">
          按住说话，松手发送。每分钟最多 10 次，单段最长 55 秒。录音只用于转写，不给发音打分。
        </div>
      ) : null}
    </div>
  );
}

/**
 * 把对话稿折成小结要的 (转写, 回复) 对：学员每说一句，店员回的那一句就是这一轮。
 * 学员连着说两句（中间店员还没回）时，只有最后一句配得上回复——前面那句没有回复可配，
 * 丢掉比编一句好。
 */
function pairRounds(turns: readonly ScriptTurn[]): RoleplayRound[] {
  const rounds: RoleplayRound[] = [];
  let pending: string | null = null;
  for (const turn of turns) {
    // 还在流式的那句不算回复：正文还没定。
    if (turn.streaming) continue;
    if (turn.role === "student") {
      pending = turn.text === EMPTY_TRANSCRIPT_TEXT ? "" : turn.text;
      continue;
    }
    if (pending !== null) {
      rounds.push({ transcript: pending, reply: turn.text });
      pending = null;
    }
  }
  return rounds;
}

/** 一次播放收尾时给学员看的那一行（放完 / 被取消不说话）。 */
function playbackNote(outcome: PlaybackOutcome): string | null {
  switch (outcome.status) {
    case "played":
    case "cancelled":
    // 回合失败：这一句本来就不在对话稿里（失败消息被折掉，同改前），不把它说成「没有语音」。
    case "turn_failed":
      return null;
    case "none":
      return "这一轮没有语音（这一版 Agent 没有声明 voice.output）。";
    case "pending":
      return "语音还在合成，点 🔊 再试一次。";
    case "failed":
      return `这句话没能播放${outcome.code ? `（${outcome.code}）` : ""}，点 🔊 再试一次。`;
    case "blocked":
      return "刚才没能播放，点 🔊 再试一次。";
    case "partial":
      return `这句话有一段没能播放${outcome.code ? `（${outcome.code}）` : ""}，点 🔊 再听一遍。`;
  }
}
