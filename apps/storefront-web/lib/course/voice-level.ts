/**
 * 跟读录音的音量门限：整段几乎无声就不发语音回合。
 *
 * 为什么要挡：qwen3-asr-flash 不会把静音转成空串，会转出一句像样的英文——生产站点上 3 s 静音
 * 转成「Thank you.」、7 s 静音转成一整句「The first thing that I would do is I would go to the
 * police.」。页面拿它和原句比对会判出半对半错，旧 prompt
 * 还把那句幻听当成孩子在求助。所以在发之前先看一眼录到的是不是有声音。
 *
 * 判法：把整段切成 50 ms 的窗，算每个窗的 RMS；超过门限的窗加起来不到 150 ms 就算「几乎无声」。
 * - 门限 0.01（约 −40 dBFS）：开着降噪的麦克风，安静房间里的底噪在这以下；孩子说话哪怕轻声，
 *   出声的那几百毫秒都在这以上。
 * - 要求累计 150 ms 而不是「有一个窗过了」：按下 / 松开按钮的那一下咔哒声只占一两个窗，不该让
 *   一段静音混过去；而最短的一个词（Hi）也有两三百毫秒。
 * 纯函数，`scripts/english-lesson/check.mjs` 的 F7 拿合成的波形核（静音、底噪、咔哒声、轻声、正常说话）。
 */

/** 一个窗的 RMS 超过它，这个窗就算「有声音」。 */
export const VOICE_RMS_THRESHOLD = 0.01;
/** 窗长。 */
export const VOICE_WINDOW_MS = 50;
/** 有声音的窗累计不到这么长，整段就算几乎无声。 */
export const VOICE_MIN_VOICED_MS = 150;

/** 有声音的窗累计多少毫秒（单声道样本，-1..1）。 */
export function voicedMs(samples: Float32Array, sampleRate: number, threshold = VOICE_RMS_THRESHOLD): number {
  const size = Math.max(1, Math.round((sampleRate * VOICE_WINDOW_MS) / 1000));
  let voiced = 0;
  for (let start = 0; start < samples.length; start += size) {
    const end = Math.min(samples.length, start + size);
    let sum = 0;
    for (let i = start; i < end; i += 1) sum += samples[i] * samples[i];
    if (Math.sqrt(sum / (end - start)) > threshold) voiced += ((end - start) * 1000) / sampleRate;
  }
  return Math.round(voiced);
}

export function isNearlySilent(samples: Float32Array, sampleRate: number): boolean {
  return voicedMs(samples, sampleRate) < VOICE_MIN_VOICED_MS;
}
