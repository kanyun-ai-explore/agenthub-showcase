"use client";

/**
 * 按住说话的那台状态机：按下 → getUserMedia → MediaRecorder → 松手收尾 → 交出一段音。
 *
 * 从二期跟读卡里抽出来给情景对话（三期）用；改版之后跟读卡改成交给页面回合队列的
 * 哑组件、自带一份录音逻辑，眼下只有情景对话用这一台。里面有四处**踩过坑**的判断：
 * - `startingRef` 同步置位：`phase` 要到 `recorder.start()` 之后才变 `"recording"`，
 *   但 `getUserMedia` 的 await 窗口里手指可以松开再按下——只靠 `phase` 防不住第二次
 *   起录，会造出两个 MediaRecorder（第一个的麦克风轨道没人停，它的 dataavailable 还会
 *   灌进下一个 take 的 chunks）；
 * - `pressedRef`：权限弹窗期间松手是常事，那时**不开始录**（录出一段没人说话的空白音
 *   只会白占一次限额、换来一句「没听清」）；
 * - 55 s 自己收尾：平台的 60 s 上限是在**上传之后**才拒的，多录那几秒只是白传一次；
 * - 每分钟 10 次的本地闸：平台的 429 是兜底，不该是用户第一次听到的答案。窗口只在
 *   **发送成功之后**才推进（失败的那次不该占额度）。
 *
 * 提示文案由调用方给。所有文案与限额都来自
 * `lib/agenthub/voice-recording.ts`，那里逐个标了平台出处。
 */

import { useCallback, useEffect, useRef, useState } from "react";
import {
  pickVoiceMimeType,
  pruneVoiceTurnTimes,
  VOICE_MAX_BYTES,
  VOICE_MAX_RECORDING_MS,
  VOICE_TURNS_PER_MINUTE,
  voiceRecordingFilename,
  voiceTakeTooLarge,
  type VoiceTake,
} from "@/lib/agenthub/voice-recording";

export type VoicePhase = "idle" | "recording" | "sending";

export interface VoiceTakeOptions {
  /** 会话还没就绪 / 上一轮还没回来时不接新的录音。 */
  disabled: boolean;
  sessionId: string | null;
  /** 一段录完的音往哪走。返回 `null` = 发出去了（这一下占额度）；返回一段话 = 没发出去，
   *  那句话就是给用户看的提示（不占额度）。 */
  onTake: (take: VoiceTake) => Promise<string | null>;
  /** 每分钟超限时的提示，`{n}` 换成限额。 */
  rateLimitedNotice?: string;
  /** 按下到松手之间就松了手的提示（权限弹窗那一段）。 */
  holdHint?: string;
  /** 松手时还没录到东西的提示。 */
  tooShortNotice?: string;
  /** 超过 2 MB 的提示。 */
  tooLargeNotice?: string;
}

export interface VoiceTakeController {
  phase: VoicePhase;
  recording: boolean;
  elapsedMs: number;
  /** 录音/发送这一路自己的提示（页面自己那层校验的错误不走这里）。 */
  error: string | null;
  notice: string | null;
  /** 真正的按下 / 松手：接在 pointerdown / pointerup+cancel+leave 上。 */
  press: () => void;
  release: () => void;
  clearMessages: () => void;
}

const fmtMb = Math.round(VOICE_MAX_BYTES / 1024 / 1024);

export function useVoiceTake({
  disabled,
  sessionId,
  onTake,
  rateLimitedNotice = `每分钟最多跟读 ${VOICE_TURNS_PER_MINUTE} 次，歇一小会儿再来。`,
  holdHint = "按住不放，把整句读完再松手。",
  tooShortNotice = "这一下太短了，按住按钮把整句读完再松手。",
  tooLargeNotice = `这段录音超过 ${fmtMb} MB，短一点再读一次。`,
}: VoiceTakeOptions): VoiceTakeController {
  const [phase, setPhase] = useState<VoicePhase>("idle");
  const [elapsedMs, setElapsedMs] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const recorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const startedAtRef = useRef(0);
  const stopTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const tickTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  /** 这个会话里已经成功发出去的语音回合时刻（本地闸；平台的 429 是兜底）。 */
  const turnTimesRef = useRef<number[]>([]);
  /** 手指还按着吗。`getUserMedia` 可能弹权限框，等待期间松手是常事。 */
  const pressedRef = useRef(false);
  /** 已经有一次 `startRecording` 在跑（等权限 / 等轨道）——同步置位，才是真正的闸。 */
  const startingRef = useRef(false);
  const aliveRef = useRef(true);
  /** onTake 每次渲染可能换引用，起点录那一下要取最新的。 */
  const onTakeRef = useRef(onTake);
  onTakeRef.current = onTake;

  const clearTimers = useCallback(() => {
    if (stopTimerRef.current) clearTimeout(stopTimerRef.current);
    if (tickTimerRef.current) clearInterval(tickTimerRef.current);
    stopTimerRef.current = null;
    tickTimerRef.current = null;
  }, []);

  useEffect(() => {
    // ⚠️ 正文里要把它置回 true：开发期（React 严格模式）effect 会跑两遍
    // （mount → cleanup → mount），只在 cleanup 里置 false 的话，第二遍之后这个 ref 就
    // 永远是 false——表现是「按下去什么都不发生」，既不录音也不报错。本地走查抓到的就是它。
    aliveRef.current = true;
    return () => {
      aliveRef.current = false;
      clearTimers();
      recorderRef.current?.stream.getTracks().forEach((track) => track.stop());
    };
  }, [clearTimers]);

  const finishTake = useCallback(async () => {
    const recorder = recorderRef.current;
    recorderRef.current = null;
    clearTimers();
    const durationMs = Date.now() - startedAtRef.current;
    const mimeType = recorder?.mimeType || chunksRef.current[0]?.type || "audio/webm";
    const blob = new Blob(chunksRef.current, { type: mimeType });
    chunksRef.current = [];
    setElapsedMs(0);
    if (blob.size === 0) {
      setPhase("idle");
      setNotice(tooShortNotice);
      return;
    }
    if (voiceTakeTooLarge(blob)) {
      setPhase("idle");
      setError(tooLargeNotice);
      return;
    }
    setPhase("sending");
    setError(null);
    setNotice(null);
    const failure = await onTakeRef.current({ blob, filename: voiceRecordingFilename(mimeType), mimeType, durationMs });
    if (!aliveRef.current) return;
    setPhase("idle");
    if (failure) setError(failure);
    else turnTimesRef.current = [...pruneVoiceTurnTimes(turnTimesRef.current, Date.now()), Date.now()];
  }, [clearTimers, tooLargeNotice, tooShortNotice]);

  const release = useCallback(() => {
    pressedRef.current = false;
    const recorder = recorderRef.current;
    if (!recorder || recorder.state === "inactive") return;
    recorder.stop();
  }, []);

  const press = useCallback(() => {
    // ⚠️ 先记「手指按着」，再走后面的闸：`getUserMedia` 那一段是 await 的，判「松手了没」
    // 靠的就是这个 ref。这条与 `release()` 是一对，缺了它每次录音都会被当成「还没开始就
    // 松手了」——本地走查（scripts/roleplay-acceptance 的浏览器那一半）抓的就是这个。
    pressedRef.current = true;
    if (disabled || phase !== "idle" || !sessionId || startingRef.current) return;
    startingRef.current = true;
    const release_startGate = () => {
      startingRef.current = false;
    };
    const recent = pruneVoiceTurnTimes(turnTimesRef.current, Date.now());
    if (recent.length >= VOICE_TURNS_PER_MINUTE) {
      setNotice(rateLimitedNotice.replace("{n}", String(VOICE_TURNS_PER_MINUTE)));
      release_startGate();
      return;
    }
    setError(null);
    setNotice(null);
    void (async () => {
      let stream: MediaStream;
      try {
        stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      } catch {
        setError("没有拿到麦克风权限，看看浏览器设置里是不是挡住了。");
        release_startGate();
        return;
      }
      if (!aliveRef.current) {
        stream.getTracks().forEach((track) => track.stop());
        release_startGate();
        return;
      }
      // 等权限框的这几秒里孩子可能已经松手了：这时**不开始录**。真录下去的话，一段
      // 没人说话的空白音频会占掉每分钟 10 次里的一次，还换来一句「没听清」。
      if (!pressedRef.current) {
        stream.getTracks().forEach((track) => track.stop());
        setNotice(holdHint);
        release_startGate();
        return;
      }
      const mimeType = pickVoiceMimeType(
        typeof MediaRecorder !== "undefined" && typeof MediaRecorder.isTypeSupported === "function"
          ? (type) => MediaRecorder.isTypeSupported(type)
          : undefined,
      );
      const recorder = mimeType ? new MediaRecorder(stream, { mimeType }) : new MediaRecorder(stream);
      chunksRef.current = [];
      recorder.addEventListener("dataavailable", (event) => {
        if (event.data.size > 0) chunksRef.current.push(event.data);
      });
      recorder.addEventListener("stop", () => {
        stream.getTracks().forEach((track) => track.stop());
        void finishTake();
      });
      recorderRef.current = recorder;
      startedAtRef.current = Date.now();
      try {
        recorder.start();
      } catch {
        recorderRef.current = null;
        stream.getTracks().forEach((track) => track.stop());
        setError("这个浏览器录不了音，换一个浏览器试试。");
        release_startGate();
        return;
      }
      setPhase("recording");
      release_startGate();
      setElapsedMs(0);
      tickTimerRef.current = setInterval(() => setElapsedMs(Date.now() - startedAtRef.current), 200);
      // 自己先收尾：平台的 60 s 上限是在上传之后才拒的，多录的几秒只是白传一次。
      stopTimerRef.current = setTimeout(() => release(), VOICE_MAX_RECORDING_MS);
    })();
  }, [disabled, finishTake, holdHint, phase, rateLimitedNotice, release, sessionId]);

  const clearMessages = useCallback(() => {
    setError(null);
    setNotice(null);
  }, []);

  return {
    phase,
    recording: phase === "recording",
    elapsedMs,
    error,
    notice,
    press,
    release,
    clearMessages,
  };
}
