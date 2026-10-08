"use client";

/**
 * 情景对话（Roleplay）：咖啡店。沿用闯关式课程页的骨架，但这一节练的是**对话**——
 * 店员（一个 `format: live` 的 agent）先说一句，学员按住按钮用英语回一句，来回 3–4 轮，
 * 最后出一张小结卡。
 *
 * 三处与一/二期的课不同：
 * - **agent 是 live 的**：不建沙箱、不调工具，回复快；但也因此**小结卡只能前端算**
 *   （`lib/course/roleplay-summary.ts`），不靠 `present_*`。
 * - **每一句店员的话都会被合成成音频**（`voice.output`），页面在它到的时候自动播一遍，
 *   每条还留一个 🔊 供重听——对讲机的听感靠这个，不是靠文字。
 * - **录音这一台与跟读卡共用**（`useVoiceTake`）：按住说话、松手就发、每分钟 10 次、
 *   单段 60 s / 2 MB，都是同一份实现与同一套提示。
 *
 * 无沙箱 = 没有「沙箱就绪」那一段等待，所以这里的开场按钮点下去直接就进对话。
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { EMPTY_TRANSCRIPT_TEXT, type Conversation } from "@/components/agent/useAgentConversation";
import { playSegments, readTurnAudio, type AudioSegment } from "@/lib/agenthub/turn-audio-client";
import { summarizeRoleplay, type RoleplayRound } from "@/lib/course/roleplay-summary";
import { finishRoleplay, readRoleplay, type RoleplayProgress } from "@/lib/showcase/progress";
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

interface ScriptTurn {
  role: "barista" | "student";
  text: string;
  /** 店员那句话的 turnId（取回合音频用）。 */
  turnId?: string;
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
  // ⚠️ 不能按消息顺序直接堆：语音路径上 agent 的**占位气泡先入列**（`dispatchVoice` 起点就
  // push 一条空的 agent 消息，给流式输出留位置），学员那一轮的转写是**回包之后**才补进去的。
  // 按顺序遍历会得到「店员 → 店员 → 学员」这种错位，配上对就是「上一句回下一句」。所以两份
  // 各自成列、按下标对齐：第 i 个学员的话 ⇄ 第 i+1 条店员的话（第 0 条是开场问候）。
  const turns = useMemo<ScriptTurn[]>(() => {
    const baristas: ScriptTurn[] = [];
    const students: string[] = [];
    for (const message of conversation.messages) {
      if (message.role === "user") {
        // 开场那句是页面替学员说的，不算他的一轮。
        if (message.text.trim() && message.text !== opener) students.push(message.text);
        continue;
      }
      if (message.role !== "agent") continue;
      // 流式中的半句话、以及失败的空壳都不算一条台词（失败的那轮在语音路径上根本不会留下气泡）。
      if (message.streaming || message.failed || !message.text.trim()) continue;
      baristas.push({ role: "barista", text: message.text.trim(), ...(message.turnId ? { turnId: message.turnId } : {}) });
    }
    const out: ScriptTurn[] = [];
    for (let i = 0; i < baristas.length; i += 1) {
      if (i > 0 && students[i - 1] !== undefined) out.push({ role: "student", text: students[i - 1] });
      out.push(baristas[i]);
    }
    // 学员说了、店员还没回（正在生成或刚失败）：也要显示，不然那一句像丢了。
    for (let i = Math.max(baristas.length - 1, 0); i < students.length; i += 1) {
      out.push({ role: "student", text: students[i] });
    }
    return out;
  }, [conversation.messages, opener]);

  const studentTurns = turns.filter((t) => t.role === "student").length;
  const round = Math.min(studentTurns + 1, MAX_ROUNDS);

  /** 小结卡的口径：每一轮学员说完之后店员回的那一句。 */
  const summary = useMemo(() => summarizeRoleplay(pairRounds(turns)), [turns]);

  const started = conversation.messages.length > 0;

  /**
   * 最近一次「要播某一句」的发起（turnId）。**每一次发起都要先在这里记一笔**，响应回来
   * 时对不上就整段丢掉——这条与跟读卡 `latestTurnRef` 是同一类问题：
   *
   * `readTurnAudio` 是 `wait=1`，服务端最多等 20 s 合成。这 20 s 里学员完全可以录下一句
   * ——店员回话、页面自动播新一轮；上一轮那句音频晚到时若照播不误，就会在**同一个
   * audioRef** 上把新一轮盖掉，或者两段叠着播。重听按钮按下的那一刻算一次新发起。
   */
  const latestPlayRef = useRef<string | null>(null);
  /**
   * 手指还按在「按住说话」上（含 `getUserMedia` 等权限的那一段）。这期间**任何播放都不许
   * 开始**——自动播、🔊 重听（触屏上第二根手指点得到）、晚到的读取都走 `playTurn`，闸就设在
   * 它的入口这一处。已经在放的那句由按下时的 `stopPlayback` 停掉。两件合起来才是半双工。
   */
  const holdingRef = useRef(false);

  // ── 店员这句话的音频：到了就自动播一遍，也可以按 🔊 重听 ────────────────────
  const playTurn = useCallback(
    async (turnId: string) => {
      if (!conversation.sessionId || holdingRef.current) return;
      latestPlayRef.current = turnId;
      setAudioNote(null);
      // 新一次发起就把「正在播…」收掉：上一次那条已经没有指示灯的主人了（它自己的 finally
      // 会被下面的守卫跳过，留着它只会让按钮永远显示「正在播…」而其实无声）。
      setPlayingTurnId(null);
      /** 收状态只归「当前这一次发起」——作废的那次不许按掉新一轮的指示灯。 */
      const releasePlaying = () => {
        if (latestPlayRef.current === turnId) setPlayingTurnId(null);
      };
      const audio = await readTurnAudio(conversation.sessionId, turnId);
      // 这次响应已经过时了（学员又说了下一句、或又点了一次重听）：丢掉——不播、不提示、
      // 也不动播放状态（否则会把正在播的那一句的状态一起清掉）。
      if (latestPlayRef.current !== turnId) return;
      if (audio.status === "none") {
        releasePlaying();
        setAudioNote("这一轮没有语音（agent 这一版没声明 voice.output）。");
        return;
      }
      if (audio.status === "pending") {
        releasePlaying();
        setAudioNote("语音还在合成，点 🔊 再试一次。");
        return;
      }
      if (audio.status === "failed") {
        releasePlaying();
        setAudioNote(`这句话没放出来${audio.code ? `（${audio.code}）` : ""}，点 🔊 再试一次。`);
        return;
      }
      const element = audioRef.current ?? new Audio();
      audioRef.current = element;
      setPlayingTurnId(turnId);
      try {
        await playSegments(audio.segments as AudioSegment[], element);
      } catch {
        if (latestPlayRef.current === turnId) setAudioNote("刚才没放出来，点 🔊 再试一次。");
      } finally {
        releasePlaying();
      }
    },
    [conversation.sessionId],
  );

  /**
   * 按住说话的那一刻把店员的声音停掉（半双工：同一时刻只有一方在说）。不停的话，店员那句
   * 还在扬声器里放——或者 `readTurnAudio` 的 20 s 等待之后才开始放——就会被录进学员这段，
   * 转写把店员的原话当成学员说的交给 agent，小结卡也会把它数成学员的词和句型。
   * 置空 `latestPlayRef` 让在路上的那次读取回来时自己作废；摘掉回调再 pause，被打断的那次
   * `playSegments` 就不会再动指示灯。想再听，按 🔊。
   */
  const stopPlayback = useCallback(() => {
    latestPlayRef.current = null;
    const element = audioRef.current;
    if (element) {
      element.onended = null;
      element.onerror = null;
      element.pause();
    }
    setPlayingTurnId(null);
  }, []);

  // 店员的新台词一到就自动播。浏览器的自动播放策略要求先有用户手势——开场按钮那次点击
  // 就是手势，所以从第一句起就放得出来。
  const latestBarista = [...turns].reverse().find((t) => t.role === "barista" && t.turnId);
  useEffect(() => {
    if (!latestBarista?.turnId) return;
    if (playedRef.current.has(latestBarista.turnId)) return;
    playedRef.current.add(latestBarista.turnId);
    void playTurn(latestBarista.turnId);
  }, [latestBarista, playTurn]);

  useEffect(() => {
    stageRef.current?.scrollTo({ top: stageRef.current.scrollHeight, behavior: "smooth" });
  }, [turns.length]);

  // ── 录音：一段音 → 一轮语音回合 ─────────────────────────────────────────────
  const voice = useVoiceTake({
    disabled: conversation.busy || summaryOpen,
    sessionId: conversation.sessionId,
    rateLimitedNotice: "一分钟里最多说 10 次，歇一小会儿再来。",
    holdHint: "按住按钮别松手，把整句说完再松。",
    tooShortNotice: "这一下太短了，按住按钮把整句说完再松手。",
    onTake: async (take) => {
      const outcome = await conversation.sendVoice(take);
      if (!outcome.ok) return outcome.error ?? "这次没发出去，再试一次。";
      // 学员这句话也会被另存成一条 user 消息（转写），对话稿从那里长出来。
      // 语音回合分两段到：转写在派发后就回来，店员那句另外到（`reply`）。等它落定再收尾——
      // 不然「Sam 正在听…」提前熄掉，第 4 轮还没听到店员道别，小结卡就先盖上来了。
      await outcome.reply;
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
    holdingRef.current = false;
    voice.release();
  };

  const startedOnce = turns.length > 0;
  const holdLabel = voice.recording
    ? `松开发送 · ${Math.round(voice.elapsedMs / 1000)}s`
    : voice.phase === "sending"
      ? `${clerkName} 正在听…`
      : "🎙 按住说话";

  return (
    <div className="m-app en-app">
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
                  {playingTurnId === turn.turnId ? "🔊 正在播…" : "🔊 再听一遍"}
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
            disabled={conversation.busy || voice.phase === "sending" || !conversation.sessionId}
            onPointerDown={(event) => {
              event.preventDefault();
              holdingRef.current = true;
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
            小结只看你说了什么，不打分、不评发音（转写会顺手把读音纠成正确的词，评不准）。
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
            这个视角的 agent 还没配置（缺 AGENTHUB_ROLEPLAY_AGENT_ID）。
          </div>
        </div>
      ) : null}

      {!summaryOpen && startedOnce ? (
        <div className="en-read-limit rp-limit">
          按住说话，松手就发；每分钟最多 10 次、单段最长 60 秒。录音只用来转写，不打发音分。
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
