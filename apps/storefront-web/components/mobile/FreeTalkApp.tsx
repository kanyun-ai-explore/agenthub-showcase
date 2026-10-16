"use client";

/**
 * 自由对话：和 Ava 用英语实时通话。浏览器和平台的实时语音网关建一条 WebSocket，
 * 麦克风音频上行、模型的原生音频下行，没有「转写 → 文本模型 → 合成」三段。
 *
 * 页面做四件事：
 * 1. 建会话 → 换票（`/api/agenthub/voice-ticket`）→ 把票交给 SDK 建连；
 * 2. 把 `onTranscript` 的增量帧折成一轮一句话画出来；
 * 3. 画通话状态，Ava 在说的时候可以打断；
 * 4. 挂断后把转写随 `【点评】` 发给同一个会话，拿回中文点评。学员最后那句没说完的，点评带上已到手的半句并标「未说完」。
 *
 * 实时通话建不起来时（判定在 `lib/agenthub/realtime-errors.ts`）退到按住说话：
 * 同一个会话、同一份提示词，走 `useVoiceTake` + `/api/agenthub/voice-turn`。
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  createRealtimeVoiceClient,
  type RealtimeTranscript,
  type RealtimeVoiceClient,
  type RealtimeVoiceState,
} from "@kanyun-ai-infra/agenthub/realtime";
import type { Conversation } from "@/components/agent/useAgentConversation";
import { playSegmentOn, readTurnAudioOnce } from "@/lib/agenthub/turn-audio-client";
import { startTurnAudioPlayback, type Playback, type PlaybackOutcome } from "@/lib/agenthub/turn-audio-player";
import {
  classifyCallFailure,
  createNoResponseStreak,
  FALLBACK_NOTICE,
  realtimeErrorMessage,
  type TicketFailure,
} from "@/lib/agenthub/realtime-errors";
import {
  buildReviewRequest,
  foldRealtimeTranscript,
  freetalkLines,
  hasAnythingToReview,
  unfinishedUserTurn,
  type FreetalkTurn,
} from "@/lib/agenthub/realtime-transcript";
import { VOICE_DEGRADED, VOICE_NOTICE } from "@/lib/showcase/voice-status";
import { EnStatusBar } from "./english/EnIcons";
import { Octo } from "./Octo";
import { useVoiceTake } from "./useVoiceTake";

const STATE_LABEL: Record<RealtimeVoiceState, string> = {
  listening: "在听你说…",
  thinking: "Ava 在想…",
  speaking: "Ava 在说 · 可以打断",
};

/** 等会话就绪的上限，要短于 SDK 等票的 10 s。 */
const SESSION_WAIT_MS = 8_000;
const SESSION_POLL_MS = 200;
/** 刚挂断时会话可能还占着，点评那一轮重试几次。 */
const REVIEW_ATTEMPTS = 4;
const REVIEW_RETRY_MS = 1_500;

type CallPhase = "idle" | "connecting" | "live" | "over";
type Mode = "realtime" | "fallback";
type ReviewState = { state: "idle" | "writing" | "ready" | "failed"; text?: string };

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function FreeTalkApp({
  conversation,
  openers,
  agentName = "Ava",
  sceneTitle = "自由对话",
  welcomeText = "点一下开始，麦克风会一直开着，你和 Ava 像打电话一样用英语聊天。聊完了挂断，会给你一张带转写的点评卡。",
}: {
  conversation: Conversation;
  openers: string[];
  agentName?: string;
  sceneTitle?: string;
  welcomeText?: string;
}) {
  const opener = openers[0] ?? "开始自由对话";
  const labels = useMemo(() => ({ user: "你", agent: agentName }), [agentName]);

  const [callPhase, setCallPhase] = useState<CallPhase>("idle");
  const [mode, setMode] = useState<Mode>("realtime");
  const [voiceState, setVoiceState] = useState<RealtimeVoiceState | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [reconnecting, setReconnecting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [turns, setTurns] = useState<FreetalkTurn[]>([]);
  const [review, setReview] = useState<ReviewState>({ state: "idle" });
  const [reviewOpen, setReviewOpen] = useState(false);
  const [playingTurnId, setPlayingTurnId] = useState<string | null>(null);
  const [audioNote, setAudioNote] = useState<string | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const playbackRef = useRef<Playback | null>(null);

  const stageRef = useRef<HTMLDivElement>(null);
  /** 网关发来的原始帧（增量）。 */
  const eventsRef = useRef<RealtimeTranscript[]>([]);
  /** 回落后按住说话的那几轮，接着实时那些轮往下编号。 */
  const fallbackRef = useRef<FreetalkTurn[]>([]);
  // SDK 的回调里读不到最新的 state，会话 id、阶段和下面的 modeRef 都走 ref。
  const sessionIdRef = useRef<string | null>(conversation.sessionId);
  sessionIdRef.current = conversation.sessionId;
  const phaseRef = useRef(conversation.phase);
  phaseRef.current = conversation.phase;
  const maxSeqRef = useRef(0);
  /** 换票失败的原因：SDK 只会报 `CONNECTION_FAILED`，原因要自己留。 */
  const ticketFailureRef = useRef<TicketFailure | null>(null);
  const ticketIssuedRef = useRef(false);
  const gatewayUrlRef = useRef("");
  const noResponse = useRef(createNoResponseStreak());
  const clientRef = useRef<RealtimeVoiceClient | null>(null);
  /** 挂断之后晚到的 SDK 回调不再改页面（`stop()` 之后 SDK 也不再送转写）。 */
  const endedRef = useRef(false);
  const unfinishedTurnRef = useRef<number | null>(null);
  const aliveRef = useRef(true);
  useEffect(() => {
    aliveRef.current = true;
    return () => {
      aliveRef.current = false;
      playbackRef.current?.cancel();
      void clientRef.current?.stop();
    };
  }, []);

  const republishTurns = useCallback(() => {
    const realtime = foldRealtimeTranscript(eventsRef.current);
    maxSeqRef.current = Math.max(maxSeqRef.current, 0, ...realtime.map((turn) => turn.turnSeq));
    setTurns([...realtime, ...fallbackRef.current]);
  }, []);

  /** 此刻的对话稿，从 ref 现取：`turns` 这个 state 可能还差最后几帧没渲染。 */
  const snapshotTurns = useCallback(
    (): FreetalkTurn[] => [...foldRealtimeTranscript(eventsRef.current), ...fallbackRef.current],
    [],
  );

  /** 等会话建出来并且就绪：会话没就绪时换票会被平台拒（409 `SESSION_NOT_READY`）。 */
  const waitForSessionId = useCallback(async (): Promise<string> => {
    const deadline = Date.now() + SESSION_WAIT_MS;
    for (;;) {
      const sid = sessionIdRef.current;
      if (sid && phaseRef.current === "ready") return sid;
      if (phaseRef.current === "unconfigured") throw new Error("not_configured");
      if (Date.now() >= deadline) throw new Error("SESSION_TIMEOUT");
      await sleep(SESSION_POLL_MS);
    }
  }, []);

  const modeRef = useRef<Mode>("realtime");
  modeRef.current = mode;

  /** 回落到按住说话，同一个会话接着聊。一次通话只回落一次。 */
  const fallBack = useCallback((reason: string) => {
    if (endedRef.current || modeRef.current === "fallback") return;
    modeRef.current = "fallback";
    setMode("fallback");
    setNotice(FALLBACK_NOTICE);
    setError(null);
    setVoiceState(null);
    setReconnecting(false);
    setCallPhase("live");
    console.warn(`[freetalk] realtime → 按住说话：${reason}`);
    void clientRef.current?.stop();
  }, []);

  const handleFailure = useCallback(
    (code: string, retryable: boolean) => {
      if (endedRef.current) return;
      const ticket = ticketFailureRef.current;
      const decision = classifyCallFailure({
        code,
        ticket,
        ticketIssued: ticketIssuedRef.current,
        noResponseStreak: noResponse.current.observe(code),
      });
      if (decision.action === "fallback") {
        fallBack(decision.code ?? code);
        return;
      }
      if (decision.action === "ignore") {
        setNotice(realtimeErrorMessage(decision.code ?? code));
        return;
      }
      setError(realtimeErrorMessage(decision.code ?? code));
      // error 和 retry 之后这一通都已经结束（建连失败，或者通话中 SDK 报错后自己停了）：退回开场，让「开始通话」能再按。
      if (decision.action === "error" || decision.action === "retry") {
        setCallPhase("idle");
        setVoiceState(null);
        setReconnecting(false);
      }
    },
    [fallBack],
  );

  const ensureClient = useCallback((): RealtimeVoiceClient => {
    if (clientRef.current) return clientRef.current;
    const client = createRealtimeVoiceClient({
      // 网关地址在换票回包里才有，SDK 在 `getTicket()` 之后才读它，所以写成 getter。
      get gatewayUrl() {
        return gatewayUrlRef.current;
      },
      getTicket: async () => {
        let sid: string;
        try {
          sid = await waitForSessionId();
        } catch (err) {
          ticketFailureRef.current = { status: 0, code: err instanceof Error ? err.message : "SESSION_TIMEOUT" };
          throw err;
        }
        const res = await fetch("/api/agenthub/voice-ticket", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ sessionId: sid }),
        });
        if (!res.ok) {
          const body = (await res.json().catch(() => ({}))) as { error?: unknown };
          const failure: TicketFailure = {
            status: res.status,
            code: typeof body.error === "string" ? body.error : undefined,
          };
          ticketFailureRef.current = failure;
          throw new Error(failure.code ?? "voice_ticket_failed");
        }
        const data = (await res.json()) as { ticket?: unknown; gatewayUrl?: unknown };
        if (typeof data.ticket !== "string" || typeof data.gatewayUrl !== "string") {
          ticketFailureRef.current = { status: 502, code: "voice_ticket_failed" };
          throw new Error("voice_ticket_failed");
        }
        gatewayUrlRef.current = data.gatewayUrl;
        ticketIssuedRef.current = true;
        // 拿到新票就清掉上一次的失败，否则重连时吃过的一次错会被当成之后每条错误的原因。
        ticketFailureRef.current = null;
        return data.ticket;
      },
      onTranscript: (event) => {
        eventsRef.current.push(event);
        republishTurns();
      },
      onState: (state) => {
        if (endedRef.current) return;
        setVoiceState(state);
        // 又收到状态帧说明连接是活的：摘掉「正在重连」和上一条瞬时提示（回落那句不摘）。
        if (modeRef.current === "realtime") setNotice(null);
        setReconnecting(false);
        if (state === "speaking") noResponse.current.reset();
      },
      onError: (event) => {
        if (event.code === "REALTIME_STOPPED") return;
        if (event.code === "RECONNECTING") {
          setReconnecting(true);
          return;
        }
        handleFailure(event.code, event.retryable);
      },
    });
    clientRef.current = client;
    return client;
  }, [handleFailure, republishTurns, waitForSessionId]);

  /**
   * 开始通话。`client.start()` 必须在点击处理函数里同步调：SDK 要在用户手势里恢复
   * AudioContext，中间隔一个 await 浏览器就不放声音了。会话是异步建的，由 `getTicket` 去等。
   */
  const startCall = useCallback(() => {
    if (callPhase !== "idle") return;
    setError(null);
    setNotice(null);
    endedRef.current = false;
    ticketFailureRef.current = null;
    ticketIssuedRef.current = false;
    noResponse.current.reset();
    setCallPhase("connecting");
    conversation.start();
    const client = ensureClient();
    void client
      .start()
      .then(() => {
        // `start()` resolve = 网关发了 ready，这时才算接通。
        if (!endedRef.current) setCallPhase("live");
      })
      .catch(() => {
        // 失败已经在 onError 里处理过了。
      });
  }, [callPhase, conversation, ensureClient]);

  const stopReplyAudio = useCallback(() => {
    playbackRef.current?.cancel();
    playbackRef.current = null;
    audioRef.current?.pause();
    setPlayingTurnId(null);
  }, []);

  // 挂断后的点评：转写随【点评】发给同一个会话。
  useEffect(() => {
    if (callPhase !== "over" || review.state !== "idle") return;
    const finalTurns = snapshotTurns();
    if (!hasAnythingToReview(finalTurns)) {
      setReview({ state: "failed", text: "这一通没留下一句转写，没有可点评的内容。" });
      return;
    }
    const request = buildReviewRequest(finalTurns, labels, unfinishedTurnRef.current);
    setReview({ state: "writing" });
    void (async () => {
      for (let attempt = 0; attempt < REVIEW_ATTEMPTS; attempt++) {
        const outcome = await conversation.ask(request);
        if (outcome.ok && outcome.replyText?.trim()) {
          if (!aliveRef.current) return;
          setReview({ state: "ready", text: outcome.replyText.trim() });
          return;
        }
        if (outcome.code === "SESSION_TURN_IN_PROGRESS" || outcome.code === "SESSION_NOT_READY") {
          await sleep(REVIEW_RETRY_MS);
          continue;
        }
        if (!aliveRef.current) return;
        setReview({ state: "failed", text: `点评没拿到（${outcome.code ?? "unknown"}）。` });
        return;
      }
      if (!aliveRef.current) return;
      setReview({ state: "failed", text: "会话一直占着，点评没拿到。" });
    })();
  }, [callPhase, conversation, labels, review.state, snapshotTurns]);

  /**
   * 播一轮回复的合成音频，只有回落的按住说话用得到（实时通话的声音由网关直接给）。
   * turnId 一到就起播，`settled` 说这一轮跑完没有；没跑完时由调用方在终态到了之后 `settle`。
   */
  const playReply = useCallback(
    (turnId: string, options: { settled: boolean }): Playback | null => {
      const sessionId = conversation.sessionId;
      if (!sessionId || !aliveRef.current || endedRef.current) return null;
      playbackRef.current?.cancel();
      setAudioNote(null);
      setPlayingTurnId(turnId);
      const element = audioRef.current ?? new Audio();
      audioRef.current = element;
      const playback = startTurnAudioPlayback(
        {
          read: () => readTurnAudioOnce(sessionId, turnId),
          play: (segment, signal) => playSegmentOn(element, segment, signal, {}),
          sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
          now: () => performance.now(),
        },
        { settled: options.settled },
      );
      playbackRef.current = playback;
      void playback.done.then((outcome) => {
        if (playbackRef.current === playback) {
          playbackRef.current = null;
          setPlayingTurnId(null);
        }
        const note = playbackNote(outcome);
        if (note) setAudioNote(note);
      });
      return playback;
    },
    [conversation.sessionId],
  );

  // 回落：按住说话，和情景对话同一套录音与语音回合。
  const voice = useVoiceTake({
    disabled: conversation.busy || callPhase === "over",
    sessionId: conversation.sessionId,
    rateLimitedNotice: "一分钟里最多说 10 次，歇一小会儿再来。",
    holdHint: "按住按钮别松手，把整句说完再松。",
    tooShortNotice: "这一下太短了，按住按钮把整句说完再松手。",
    onTake: async (take) => {
      const outcome = await conversation.sendVoice(take);
      if (!outcome.ok) return outcome.error ?? "这次没发送成功，再试一次。";
      const playback = outcome.turnId ? playReply(outcome.turnId, { settled: false }) : null;
      const reply = await outcome.reply;
      playback?.settle(reply ? reply.ok : true);
      const userText = (outcome.transcript ?? reply?.transcript ?? "").trim();
      const agentText = (reply?.replyText ?? "").trim();
      fallbackRef.current = [
        ...fallbackRef.current,
        {
          turnSeq: maxSeqRef.current + fallbackRef.current.length + 1,
          user: userText,
          assistant: agentText,
          done: true,
          ...(outcome.turnId ? { turnId: outcome.turnId } : {}),
        },
      ];
      republishTurns();
      return null;
    },
  });

  const endCall = useCallback(() => {
    if (endedRef.current) return;
    endedRef.current = true;
    // Ava 已经在说就不算没说完：她的 speaking 状态先于她的转写到。
    unfinishedTurnRef.current = voiceState === "speaking" ? null : unfinishedUserTurn(eventsRef.current);
    setVoiceState(null);
    setReconnecting(false);
    setNotice(null);
    setCallPhase("over");
    // 回落后回复的合成音频可能还在播，挂断时一起停。
    stopReplyAudio();
    voice.cancel();
    void clientRef.current?.stop();
  }, [stopReplyAudio, voice.cancel, voiceState]);

  useEffect(() => {
    stageRef.current?.scrollTo({ top: stageRef.current.scrollHeight, behavior: "smooth" });
  }, [turns]);

  const lines = useMemo(() => freetalkLines(turns), [turns]);
  /** 有回合音频可放的轮次：只有回落的那几轮。 */
  const playableSeqs = useMemo(() => new Set(fallbackRef.current.map((turn) => turn.turnSeq)), [turns]);
  const startedOnce = callPhase !== "idle";
  const live = callPhase === "live" || callPhase === "connecting";
  const holdDisabled = conversation.busy || voice.phase === "sending" || !conversation.sessionId;
  const holdLabel = voice.recording
    ? `松开发送 · ${Math.round(voice.elapsedMs / 1000)}s`
    : voice.phase === "sending"
      ? `${agentName} 正在听…`
      : "🎙 按住说话";

  return (
    <div className="m-app en-app">
      <EnStatusBar />
      <div className="en-top">
        <div className="en-bar">
          <span className="en-bar-fill" style={{ width: mode === "realtime" && live ? "100%" : "0%" }} />
        </div>
        <div className="en-hud">
          <span className="en-hud-item" data-tone={callPhase === "live" ? "fire" : undefined}>
            {mode === "realtime" ? "🛰 实时通话" : "🎙 按住说话"}
          </span>
        </div>
      </div>

      <div className="ft-stage" ref={stageRef}>
        {!startedOnce ? (
          <div className="ft-welcome">
            <Octo mood="idle" size={104} />
            <h3>🗣 {sceneTitle}</h3>
            <p>{welcomeText}</p>
            <div className="ft-openers">
              <button type="button" className="ft-opener" onClick={startCall}>
                {opener}
              </button>
            </div>
          </div>
        ) : null}

        {startedOnce && mode === "realtime" && callPhase !== "over" ? (
          <div className="ft-state" data-state={voiceState ?? "connecting"}>
            <span className="ft-state-dot" />
            {callPhase === "connecting" ? "正在接通…" : voiceState ? STATE_LABEL[voiceState] : "在听你说…"}
          </div>
        ) : null}

        {lines.map((line, index) => (
          <div className="ft-turn" key={`${index}-${line.role}`} data-role={line.role}>
            <div className="ft-bubble">
              <span className="ft-who">{line.role === "user" ? "你" : agentName}</span>
              <p>{line.text}</p>
              {line.role === "assistant" && line.turnId && playableSeqs.has(line.turnSeq) ? (
                <button
                  type="button"
                  className="ft-replay"
                  disabled={voice.recording}
                  data-playing={playingTurnId === line.turnId}
                  onClick={() => playReply(line.turnId as string, { settled: true })}
                >
                  {playingTurnId === line.turnId ? "🔊 正在播放…" : "🔊 再听一遍"}
                </button>
              ) : null}
            </div>
          </div>
        ))}

        {notice ? <div className="en-read-notice">{notice}</div> : null}
        {VOICE_DEGRADED && mode === "fallback" ? (
          <div className="en-voice-down" role="status">
            {VOICE_NOTICE}
          </div>
        ) : null}
        {reconnecting ? <div className="en-read-notice">{realtimeErrorMessage("RECONNECTING")}</div> : null}
        {audioNote ? <div className="en-read-notice">{audioNote}</div> : null}
        {error ? (
          <div className="ft-explain" data-correct="false">
            {error}
          </div>
        ) : null}
      </div>

      {callPhase !== "over" ? (
        <div className="ft-floor">
          {mode === "realtime" && live ? (
            <>
              {voiceState === "speaking" ? (
                <button
                  type="button"
                  className="en-btn en-btn-ghost"
                  onClick={() => clientRef.current?.interrupt()}
                >
                  ✋ 打断，我说
                </button>
              ) : null}
              <button type="button" className="en-btn" disabled={callPhase !== "live"} onClick={endCall}>
                挂断，看点评 →
              </button>
            </>
          ) : null}

          {mode === "fallback" ? (
            <>
              <button
                type="button"
                className="en-btn"
                disabled={conversation.busy}
                onClick={endCall}
              >
                聊得差不多了，看点评 →
              </button>
              <button
                type="button"
                className="en-hold"
                data-recording={voice.recording}
                disabled={holdDisabled}
                onPointerDown={(event) => {
                  event.preventDefault();
                  // disabled 的按钮也会收到 pointerdown。
                  if (holdDisabled) return;
                  stopReplyAudio();
                  voice.press();
                }}
                onPointerUp={() => voice.release()}
                onPointerCancel={() => voice.release()}
                onPointerLeave={() => voice.release()}
                onContextMenu={(event) => event.preventDefault()}
              >
                <span className="en-hold-dot" />
                {holdLabel}
              </button>
              {voice.notice ? <div className="en-read-notice">{voice.notice}</div> : null}
              {voice.error ? (
                <div className="ft-explain" data-correct="false">
                  {voice.error}
                </div>
              ) : null}
            </>
          ) : null}

          {callPhase === "idle" ? (
            <button type="button" className="en-btn en-btn-primary" onClick={startCall}>
              开始通话
            </button>
          ) : null}
        </div>
      ) : null}

      {callPhase === "over" ? (
        <div className="ft-summary">
          <Octo mood="cheer" size={92} />
          <h3>{mode === "realtime" ? "这通电话打完了！" : "这段聊完了！"}</h3>
          <p className="ft-summary-sub">
            {turns.filter((turn) => turn.user).length > 0
              ? `你一共说了 ${turns.filter((turn) => turn.user).length} 句。`
              : "这次没听清你说的话，下次离麦克风近一点。"}
          </p>

          <div className="ft-sum-block">
            <b>{agentName} 的点评</b>
            {review.state === "idle" || review.state === "writing" ? (
              <p className="ft-sum-empty">{agentName} 正在写点评…</p>
            ) : review.state === "ready" ? (
              reviewOpen ? (
                <p className="ft-review-text">{review.text}</p>
              ) : (
                <button type="button" className="en-btn" onClick={() => setReviewOpen(true)}>
                  看点评
                </button>
              )
            ) : (
              <p className="ft-sum-empty">{review.text ?? "点评没拿到。"}</p>
            )}
          </div>

          <div className="ft-sum-block">
            <b>刚才的对话（转写）</b>
            {lines.length > 0 ? (
              <div className="ft-transcript">
                {lines.map((line, index) => (
                  <p key={`s-${index}-${line.role}`} data-role={line.role}>
                    <span>{line.role === "user" ? "你" : agentName}</span>
                    {line.text}
                  </p>
                ))}
              </div>
            ) : (
              <p className="ft-sum-empty">这一通没有留下一句转写。</p>
            )}
          </div>

          <p className="ft-summary-sub">
            转写是平台按你说的话转的，可能有错字；点评不给分，也不评发音。
          </p>
          <button type="button" className="en-btn en-btn-primary" onClick={() => window.location.reload()}>
            再来一次
          </button>
        </div>
      ) : null}

      {conversation.phase === "unconfigured" ? (
        <div className="ft-floor">
          <div className="ft-explain" data-correct="false">
            这个视角的 Agent 还没配置（缺少 AGENTHUB_FREETALK_AGENT_ID）。
          </div>
        </div>
      ) : null}

      {mode === "realtime" && startedOnce && callPhase !== "over" ? (
        <div className="en-read-limit ft-limit">
          麦克风一直开着，说完直接接话；想插话点「打断」。挂断后会给你一张带转写的点评卡。
        </div>
      ) : null}

      {mode === "fallback" && callPhase !== "over" ? (
        <div className="en-read-limit ft-limit">
          按住说话，松手发送。每分钟最多 10 次，单段最长 55 秒；{agentName} 的回复会读出来，按 🔊 可以再听一遍。
        </div>
      ) : null}
    </div>
  );
}

function playbackNote(outcome: PlaybackOutcome): string | null {
  switch (outcome.status) {
    case "played":
    case "cancelled":
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
