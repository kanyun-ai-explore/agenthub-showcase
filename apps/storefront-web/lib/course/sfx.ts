"use client";

/**
 * 判定音效：答对、答错、连对、过关。用 WebAudio 现合成几个音，不放音频文件——
 * 不进仓库二进制、不走网络、点「检查」的同一帧就响。
 *
 * 浏览器要求有过一次用户手势才放得出声：第一次调用一般就在「检查」的点击里，
 * 那时创建 AudioContext 正好；放不出来（老浏览器、静音策略）就安静地什么都不做。
 */

type Tone = { freq: number; at: number; dur: number; type?: OscillatorType; gain?: number };

let context: AudioContext | null = null;

function audio(): AudioContext | null {
  if (typeof window === "undefined") return null;
  try {
    if (!context) {
      const Ctor =
        window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      if (!Ctor) return null;
      context = new Ctor();
    }
    if (context.state === "suspended") void context.resume();
    return context;
  } catch {
    return null;
  }
}

function play(tones: Tone[]): void {
  const ctx = audio();
  if (!ctx) return;
  const start = ctx.currentTime + 0.01;
  for (const tone of tones) {
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = tone.type ?? "sine";
    osc.frequency.value = tone.freq;
    const t0 = start + tone.at;
    const peak = tone.gain ?? 0.18;
    gain.gain.setValueAtTime(0, t0);
    gain.gain.linearRampToValueAtTime(peak, t0 + 0.015);
    gain.gain.exponentialRampToValueAtTime(0.0001, t0 + tone.dur);
    osc.connect(gain).connect(ctx.destination);
    osc.start(t0);
    osc.stop(t0 + tone.dur + 0.02);
  }
}

export const sfx = {
  /** 答对：两个上行的亮音。 */
  correct: () =>
    play([
      { freq: 784, at: 0, dur: 0.14, type: "triangle" },
      { freq: 1175, at: 0.09, dur: 0.22, type: "triangle" },
    ]),
  /** 答错：一个低一点、往下走的闷音。 */
  wrong: () =>
    play([
      { freq: 311, at: 0, dur: 0.16, type: "square", gain: 0.08 },
      { freq: 233, at: 0.12, dur: 0.26, type: "square", gain: 0.08 },
    ]),
  /** 连对横幅。 */
  combo: () =>
    play([
      { freq: 988, at: 0, dur: 0.1, type: "triangle" },
      { freq: 1319, at: 0.07, dur: 0.1, type: "triangle" },
      { freq: 1568, at: 0.14, dur: 0.2, type: "triangle" },
    ]),
  /** 过关：一段上行琶音。 */
  complete: () =>
    play([
      { freq: 523, at: 0, dur: 0.16, type: "triangle" },
      { freq: 659, at: 0.12, dur: 0.16, type: "triangle" },
      { freq: 784, at: 0.24, dur: 0.16, type: "triangle" },
      { freq: 1047, at: 0.36, dur: 0.36, type: "triangle" },
    ]),
};
