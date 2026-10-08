/**
 * 跟读录音的纯逻辑与限额常量。没有 DOM、没有 React——判定全部来自平台自己的契约，
 * 每一处都在注释里点出来源，免得下次有人「顺手」改成一个看起来更整齐的数。
 *
 * 两个出处（都是平台契约，不是本仓的偏好）：
 * - **语音门**（平台判定「这是一段语音输入」的条件）：附件 mimeType 必须以
 *   `audio/` 开头**且**扩展名在 `.webm/.mp3/.m4a/.wav/.ogg` 里，否则它只是个普通
 *   附件，而空文本回合会被 400 拒掉。Safari 的 `MediaRecorder` 报 `audio/mp4`，
 *   同一个容器要用 `.m4a` 命名才能过门。
 * - **限额**（平台的语音限额）：单段 60 s / 2 MB，每会话
 *   每分钟 10 个语音回合。
 */

/** 录制时长上限。平台会在**上传之后**才拒 60 s 以上的段，多录的那几秒换来一次
 *  白上传；自己 55 s 就收尾，留一点给编码器补最后一个 cluster。 */
export const VOICE_MAX_RECORDING_MS = 55_000;

/** 单段字节上限（平台同一个数：2 MB）。 */
export const VOICE_MAX_BYTES = 2 * 1024 * 1024;

/** 每会话每分钟的语音回合上限（平台同一个数：10）。 */
export const VOICE_TURNS_PER_MINUTE = 10;

/**
 * `MediaRecorder` 的 MIME 偏好，从具体到宽泛。Chrome/Edge 出 `audio/webm;codecs=opus`；
 * Safari 14.1+ 只认 `audio/mp4`。最后一条是「让浏览器自己挑」——不带 `mimeType` 构造
 * `MediaRecorder` 永远合法，`recorder.mimeType` 会回报它实际选了什么。
 */
export const VOICE_MIME_PREFERENCES: readonly string[] = [
  "audio/webm;codecs=opus",
  "audio/webm",
  "audio/ogg;codecs=opus",
  "audio/mp4",
];

/** 挑第一个浏览器说能录的 MIME；`isTypeSupported` 不存在时返回 undefined（让浏览器自己挑）。 */
export function pickVoiceMimeType(
  isTypeSupported: ((type: string) => boolean) | undefined,
  preferences: readonly string[] = VOICE_MIME_PREFERENCES,
): string | undefined {
  if (typeof isTypeSupported !== "function") return undefined;
  for (const type of preferences) {
    try {
      if (isTypeSupported(type)) return type;
    } catch {
      // 抛异常的 isTypeSupported 是实现坏了，不是「不支持这个类型」——试下一个。
    }
  }
  return undefined;
}

/**
 * 上传时用的文件名：**扩展名**就是平台语音门读的那个字段。
 *
 * MP4 那一支是关键：Safari 报的 `audio/mp4` 与 `.m4a` 是同一个容器，只有后者过了门。
 * 认不出的 MIME 回落到 `.webm`——错但存在的扩展名会在服务端响亮地失败
 * （`VOICE_AUDIO_UNREADABLE`），缺扩展名则会被静默当成普通附件。
 */
export function voiceRecordingFilename(mimeType: string): string {
  const type = mimeType.toLowerCase();
  if (type.includes("webm")) return "recording.webm";
  if (type.includes("ogg") || type.includes("opus")) return "recording.ogg";
  if (type.includes("wav")) return "recording.wav";
  if (type.includes("mpeg") || type.includes("mp3")) return "recording.mp3";
  if (type.includes("mp4") || type.includes("m4a") || type.includes("aac")) return "recording.m4a";
  return "recording.webm";
}

/** 一段录完的音：字节 + 派发要用的名字 + 拿来做限额判定的时长。 */
export interface VoiceTake {
  blob: Blob;
  filename: string;
  mimeType: string;
  durationMs: number;
}

/** 客户端先挡一道：超过 2 MB 的段平台也会拒，但那是在上传之后。 */
export function voiceTakeTooLarge(blob: Blob): boolean {
  return blob.size > VOICE_MAX_BYTES;
}

/**
 * 每会话每分钟 10 次的本地闸。平台的 429 是**兜底**，不是主要提示——孩子按到第 11 次
 * 时我们该在发请求之前就拦住，而不是让他等一个往返再看到错误。
 *
 * 入参是这个会话里历次语音回合的发车时刻（毫秒）。返回窗口内还活着的那些，调用方拿
 * 它的长度和 `VOICE_TURNS_PER_MINUTE` 比。
 */
export function pruneVoiceTurnTimes(times: readonly number[], now: number): number[] {
  return times.filter((at) => now - at < 60_000);
}
