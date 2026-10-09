/**
 * 平台合成的读音是 WAV（qwen3-tts-flash 只出 WAV）。这里做三件纯粹的事：
 * 解析、把一个回合的几段拼成一段、把头里的长度改成真实值。
 *
 * - **头里的长度是流式占位值**：RIFF 大小、data 大小都是 0x7fffff..（实测）。浏览器能播，
 *   但 duration 会报成占位长度；afconvert 之类的转码工具也会被它带偏。解析时 data 大小超出实际
 *   字节就按实际字节算，输出时一律写真实长度。
 * - **一个回合可能切成几段**：平台按句切段，首段不超过 15 个字符，带逗号的句子会被切开
 *   （平台的切句规则）。几段的 fmt 必须相同，
 *   PCM 直接首尾相接。
 *
 * 纯函数、不碰 Node 专有 API：站点的 `/api/course/audio` 和 `scripts/course-audio/generate.mjs`
 * 都用它，`scripts/course-audio/check.mjs` 直接 import 跑用例。
 */

export interface Wav {
  /** fmt 块的正文（16 字节起，PCM 就是 16 字节）。 */
  fmt: Uint8Array;
  /** PCM 数据。 */
  data: Uint8Array;
}

const ascii = (bytes: Uint8Array, at: number) => String.fromCharCode(...bytes.subarray(at, at + 4));
const u32 = (bytes: Uint8Array, at: number) => new DataView(bytes.buffer, bytes.byteOffset + at, 4).getUint32(0, true);

/** 解析一段 WAV。不是 RIFF/WAVE、没有 fmt 或 data 块，返回 null。 */
export function parseWav(bytes: Uint8Array): Wav | null {
  if (bytes.length < 12 || ascii(bytes, 0) !== "RIFF" || ascii(bytes, 8) !== "WAVE") return null;
  let at = 12;
  let fmt: Uint8Array | null = null;
  while (at + 8 <= bytes.length) {
    const id = ascii(bytes, at);
    const declared = u32(bytes, at + 4);
    const bodyAt = at + 8;
    // 占位长度（或者被截断的文件）：按实际剩下的字节算。
    const size = Math.min(declared, bytes.length - bodyAt);
    if (id === "fmt ") fmt = bytes.slice(bodyAt, bodyAt + size);
    if (id === "data") {
      if (!fmt || fmt.length < 16) return null;
      return { fmt, data: bytes.slice(bodyAt, bodyAt + size) };
    }
    at = bodyAt + size + (size % 2);
  }
  return null;
}

/** 写一段头里长度都是真实值的 WAV。 */
export function buildWav({ fmt, data }: Wav): Uint8Array {
  const out = new Uint8Array(12 + 8 + fmt.length + 8 + data.length);
  const view = new DataView(out.buffer);
  const put = (at: number, s: string) => {
    for (let i = 0; i < 4; i += 1) out[at + i] = s.charCodeAt(i);
  };
  put(0, "RIFF");
  view.setUint32(4, out.length - 8, true);
  put(8, "WAVE");
  put(12, "fmt ");
  view.setUint32(16, fmt.length, true);
  out.set(fmt, 20);
  const dataAt = 20 + fmt.length;
  put(dataAt, "data");
  view.setUint32(dataAt + 4, data.length, true);
  out.set(data, dataAt + 8);
  return out;
}

/** 几段 WAV 拼成一段（fmt 必须逐字节相同）；一段也走这里，顺便把头里的长度改成真实值。 */
export function concatWav(parts: readonly Uint8Array[]): Uint8Array | null {
  const parsed = parts.map(parseWav);
  if (parsed.length === 0 || parsed.some((p) => p === null)) return null;
  const wavs = parsed as Wav[];
  const fmt = wavs[0].fmt;
  if (wavs.some((w) => w.fmt.length !== fmt.length || w.fmt.some((b, i) => b !== fmt[i]))) return null;
  const data = new Uint8Array(wavs.reduce((n, w) => n + w.data.length, 0));
  let at = 0;
  for (const w of wavs) {
    data.set(w.data, at);
    at += w.data.length;
  }
  return buildWav({ fmt, data });
}

/** PCM 时长（毫秒）：byteRate 取自 fmt 第 8–11 字节。 */
export function wavDurationMs({ fmt, data }: Wav): number {
  const byteRate = u32(fmt, 8);
  return byteRate > 0 ? Math.round((data.length / byteRate) * 1000) : 0;
}
