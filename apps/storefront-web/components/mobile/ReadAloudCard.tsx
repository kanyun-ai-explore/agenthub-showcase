"use client";

/**
 * 跟读题：按住说话 → 录音 → 交给页面的回合队列发语音回合 → 转写一回来就画逐词比对。
 *
 * 半双工：按住才录，松手就发，不做 VAD、不做打断。这是 showcase 页面对
 * 平台语音回合能力最直接的演示，不是完整应用。
 *
 * 几件事值得说明白：
 * - **没有发音分**：比对只看转写出来的词对不对，页面上如实写「转写会顺手
 *   纠错，结果偏乐观」。学员看到的绿/红/灰是「这句话读出来了没有」，不是评分。
 * - **限额在本地先拦**：每分钟 10 次、单段 60 s / 2 MB（平台契约）。超了就在这里给中文
 *   提示、不发请求——平台的 429 是兜底，不该是学员第一次听到的答案。录制到 55 s 自动
 *   收尾：平台是在**上传之后**才拒 60 s 的段，多录那几秒只是白传一次。
 * - **这张卡不发请求、不判对错**：录好的一段交给 `onTake`，由页面排进回合队列（会话同一
 *   时刻只能跑一个回合）；转写和比对结果从 `result` 传回来画。agent 的文字点评不在卡上，
 *   在判定条的「看点评」里（只要文字点评，用户点了才显示）。
 * - **几乎无声的一段不发**：转写模型会把静音转成「Thank you.」这类句子，见
 *   `lib/course/voice-level.ts`。松手后先解码看一眼音量，没声音就提示「没听到声音，按住再读一次」，
 *   不占每分钟 10 次的额度。解码不了（浏览器不支持）就照常发——没检查到不等于没声音。
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
import type { ReadingComparison } from "@/lib/course/read-aloud";
import { VOICE_MIN_VOICED_MS, voicedMs } from "@/lib/course/voice-level";
import { IconMic, IconSpeaker } from "./english/EnIcons";
import { Octo } from "./Octo";

export interface ReadAloudPayload {
  text: string;
  prompt?: string;
  hint?: string;
  explain?: string;
}

/** 这一题在回合队列里走到哪了。 */
export type ReadAloudStatus = "idle" | "queued" | "sending" | "done";

const fmtSeconds = (ms: number) => `${Math.round(ms / 1000)}s`;

/** 没声音时给学员的那句。 */
export const SILENT_TAKE_NOTICE = "没听到声音，按住再读一次";

/**
 * 解码这段录音、量一下有声音的部分有多长。解码不了（没有 OfflineAudioContext、容器读不出来）
 * 返回 `unknown`：调用方照常发，不替学员拦。
 */
async function measureTake(blob: Blob): Promise<{ gate: "silent" | "voiced" | "unknown"; voicedMs?: number }> {
  try {
    const Offline =
      typeof OfflineAudioContext !== "undefined"
        ? OfflineAudioContext
        : (globalThis as { webkitOfflineAudioContext?: typeof OfflineAudioContext }).webkitOfflineAudioContext;
    if (!Offline) return { gate: "unknown" };
    const audio = await new Offline(1, 1, 16000).decodeAudioData(await blob.arrayBuffer());
    const ms = voicedMs(audio.getChannelData(0), audio.sampleRate);
    return { gate: ms < VOICE_MIN_VOICED_MS ? "silent" : "voiced", voicedMs: ms };
  } catch {
    return { gate: "unknown" };
  }
}

function markGate(detail: string) {
  try {
    performance.mark("en:w3-gate", { detail });
  } catch {
    // 读数还在 console 里
  }
  console.info(`[english-course] w3-gate ${detail}`);
}

export function ReadAloudCard({
  payload,
  status,
  result,
  error,
  canRecord,
  onTake,
  onSkip,
  onPlayExample,
  playingExample,
}: {
  payload: ReadAloudPayload;
  status: ReadAloudStatus;
  /** 转写回来之后的比对结果；还没有就是 null。 */
  result: { transcript: string; comparison: ReadingComparison } | null;
  /** 这次没发出去（平台拒了 / 网断了）：可以直接给学员看的中文。 */
  error: string | null;
  /** 会话能不能发语音回合（没接上 agent 时只能跳过）。 */
  canRecord: boolean;
  onTake: (take: VoiceTake) => void;
  onSkip: () => void;
  /** 范例音和听音题同一条路：平台合成的读音（单元 1、2 预生成，单元 3 运行时），取不到退本机语音。 */
  onPlayExample: () => void;
  playingExample: boolean;
}) {
  const [phase, setPhase] = useState<"idle" | "recording">("idle");
  const [elapsedMs, setElapsedMs] = useState(0);
  const [notice, setNotice] = useState<string | null>(null);
  const [localError, setLocalError] = useState<string | null>(null);

  const recorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const startedAtRef = useRef(0);
  const stopTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const tickTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  /** 这张卡已经交出去的语音回合时刻（本地闸；平台的 429 是兜底）。 */
  const turnTimesRef = useRef<number[]>([]);
  /** 手指还按着吗。`getUserMedia` 可能弹权限框，等待期间学员松手是常事。 */
  const pressedRef = useRef(false);
  /**
   * 已经有一次 `startRecording` 在跑（等权限 / 等轨道）。`phase` 要到 `recorder.start()`
   * 成功之后才变 `"recording"`，只靠它防不住 await 窗口里的第二次 pointerdown——两次起录
   * 会造出**两个** MediaRecorder：第一个的轨道没人停（麦克风一直热着），它的 dataavailable
   * 还会往下一个 take 的 chunks 里灌音。这个 ref 是同步置位的，才是真正的闸。
   */
  const startingRef = useRef(false);
  /** 上一段还在量音量（松手后那几十毫秒）：这时不起新的录音，免得两段的结果交叉。 */
  const checkingRef = useRef(false);
  const aliveRef = useRef(true);

  const clearTimers = useCallback(() => {
    if (stopTimerRef.current) clearTimeout(stopTimerRef.current);
    if (tickTimerRef.current) clearInterval(tickTimerRef.current);
    stopTimerRef.current = null;
    tickTimerRef.current = null;
  }, []);

  useEffect(() => {
    // 挂载时要显式置回 true：开发态 StrictMode 会「挂载 → 清理 → 再挂载」，只在清理里置 false
    // 的话这张卡永远以为自己已经卸载，拿到麦克风后静默放弃起录（二期那版同样有这个坑）。
    aliveRef.current = true;
    return () => {
      aliveRef.current = false;
      clearTimers();
      recorderRef.current?.stream.getTracks().forEach((track) => track.stop());
    };
  }, [clearTimers]);

  const busy = status === "queued" || status === "sending";
  const disabled = !canRecord || busy || status === "done";

  // ── 录音 ────────────────────────────────────────────────────────────────

  const finishTake = useCallback(async () => {
    const recorder = recorderRef.current;
    recorderRef.current = null;
    clearTimers();
    const durationMs = Date.now() - startedAtRef.current;
    const mimeType = recorder?.mimeType || chunksRef.current[0]?.type || "audio/webm";
    const blob = new Blob(chunksRef.current, { type: mimeType });
    chunksRef.current = [];
    setElapsedMs(0);
    setPhase("idle");
    if (blob.size === 0) {
      setNotice("这一下太短了，按住按钮把整句读完再松手。");
      return;
    }
    if (voiceTakeTooLarge(blob)) {
      setLocalError(`这段录音超过 ${Math.round(VOICE_MAX_BYTES / 1024 / 1024)} MB，短一点再读一次。`);
      return;
    }
    // 音量门限在记额度之前：没声音的一段不发，也不占每分钟 10 次里的一次。
    checkingRef.current = true;
    const level = await measureTake(blob);
    checkingRef.current = false;
    markGate(`${level.gate}${level.voicedMs !== undefined ? ` 有声 ${level.voicedMs}ms` : ""}（录了 ${durationMs}ms）`);
    if (!aliveRef.current) return;
    if (level.gate === "silent") {
      setNotice(SILENT_TAKE_NOTICE);
      return;
    }
    turnTimesRef.current = [...pruneVoiceTurnTimes(turnTimesRef.current, Date.now()), Date.now()];
    onTake({ blob, filename: voiceRecordingFilename(mimeType), mimeType, durationMs });
  }, [clearTimers, onTake]);

  const stopRecording = useCallback(() => {
    pressedRef.current = false;
    const recorder = recorderRef.current;
    if (!recorder || recorder.state === "inactive") return;
    recorder.stop();
  }, []);

  const startRecording = useCallback(async () => {
    if (disabled || phase !== "idle" || startingRef.current || checkingRef.current) return;
    startingRef.current = true;
    const release = () => {
      startingRef.current = false;
    };
    const recent = pruneVoiceTurnTimes(turnTimesRef.current, Date.now());
    if (recent.length >= VOICE_TURNS_PER_MINUTE) {
      setNotice(`每分钟最多跟读 ${VOICE_TURNS_PER_MINUTE} 次，歇一小会儿再来。`);
      release();
      return;
    }
    setLocalError(null);
    setNotice(null);
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch {
      setLocalError("没有拿到麦克风权限，看看浏览器设置里是不是挡住了。也可以先跳过这道。");
      release();
      return;
    }
    if (!aliveRef.current) {
      stream.getTracks().forEach((track) => track.stop());
      release();
      return;
    }
    // 等权限框的这几秒里学员可能已经松手了：这时**不开始录**。真录下去的话，一段
    // 没人说话的空白音频会占掉每分钟 10 次里的一次，还换来一句「没听清」。
    if (!pressedRef.current) {
      stream.getTracks().forEach((track) => track.stop());
      setNotice("按住不放，把整句读完再松手。");
      release();
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
      if (aliveRef.current) void finishTake();
    });
    recorderRef.current = recorder;
    startedAtRef.current = Date.now();
    try {
      recorder.start();
    } catch {
      recorderRef.current = null;
      stream.getTracks().forEach((track) => track.stop());
      setLocalError("这个浏览器录不了音，换一个浏览器试试，或者先跳过这道。");
      release();
      return;
    }
    setPhase("recording");
    release();
    setElapsedMs(0);
    tickTimerRef.current = setInterval(() => setElapsedMs(Date.now() - startedAtRef.current), 200);
    // 自己先收尾：平台的 60 s 上限是在上传之后才拒的，多录的几秒只是白传一次。
    stopTimerRef.current = setTimeout(() => stopRecording(), VOICE_MAX_RECORDING_MS);
  }, [disabled, finishTake, phase, stopRecording]);

  // ── 渲染 ──────────────────────────────────────────────────────────────────

  const words: { word: string; state?: "right" | "wrong" | "missed" }[] = result
    ? result.comparison.words
    : payload.text
        .split(/\s+/)
        .filter(Boolean)
        .map((word) => ({ word }));
  const recording = phase === "recording";
  const holdLabel = recording
    ? `松开发送 · ${fmtSeconds(elapsedMs)}`
    : status === "queued"
      ? "排队中，老师在忙上一件事…"
      : status === "sending"
        ? "正在转写…"
        : "按住说话";
  const shownError = error ?? localError;

  return (
    <div className="en-q en-read">
      <div className="en-scene en-read-scene">
        <Octo mood="idle" size={88} />
        <div className="en-bubble en-read-bubble">
          <button
            type="button"
            className="en-speaker en-speaker-sm"
            data-playing={playingExample}
            onClick={onPlayExample}
            aria-label="听一遍例句"
          >
            <IconSpeaker size={26} />
          </button>
          <div className="en-read-words">
            {words.map((item, index) => (
              <span className="en-read-word" key={`${index}-${item.word}`} data-state={item.state ?? "idle"}>
                {item.word}
              </span>
            ))}
          </div>
        </div>
      </div>
      <div className="en-read-side">点喇叭听例句，再按住下面的按钮跟读</div>

      {result ? (
        <div className="en-read-heard">
          听到的是：{result.transcript || "（没听清）"}
          <span className="en-read-caveat">转写会顺手纠错，结果偏乐观；不打发音分。</span>
        </div>
      ) : (
        <>
          <button
            type="button"
            className="en-hold"
            data-recording={recording}
            data-busy={busy}
            disabled={disabled && !recording}
            onPointerDown={(event) => {
              event.preventDefault();
              pressedRef.current = true;
              void startRecording();
            }}
            onPointerUp={stopRecording}
            onPointerCancel={stopRecording}
            onPointerLeave={stopRecording}
            onContextMenu={(event) => event.preventDefault()}
          >
            {busy ? <span className="en-spin" /> : recording ? <span className="en-hold-dot" /> : <IconMic size={26} />}
            {holdLabel}
          </button>
          {!busy ? (
            <div className="en-read-limit">
              {canRecord
                ? "每分钟最多 10 次、单段最长 55 秒；录音只用来转写，不打发音分。"
                : "老师还没接上，这道题现在录不了音，可以先跳过。"}
            </div>
          ) : null}
        </>
      )}

      {notice ? <div className="en-read-notice">{notice}</div> : null}
      {shownError ? <div className="en-read-error">{shownError}</div> : null}

      {/* 排队中、发送中也能跳过：出题回合在飞、会话还在起的时候，
          学员不必干等。 */}
      {!result && !recording ? (
        <button type="button" className="en-skip" onClick={onSkip}>
          现在说不了，跳过这道
        </button>
      ) : null}
    </div>
  );
}
