/**
 * 平台语音路径的错误码 → 对孩子说的那句中文。
 *
 * 码表出处是平台契约（语音错误码表与 SDK 的 `PilotPlatformApiError.code`），
 * 不是猜的；认不出的码回落成一句通用提示并把原码附在括号里——展示现场看到「(SOMETHING_NEW)」
 * 比看到一句编好的假解释有用。
 *
 * 为什么不放在服务端翻译：本地闸（每分钟 10 次、2 MB）在浏览器里就已经拦了，那里的提示
 * 必须和这里同源；两边各写一份中文，迟早会漂。
 */

const MESSAGES: Record<string, string> = {
  VOICE_RATE_LIMITED: "一分钟里最多跟读 10 次，歇一小会儿再来。",
  // 走 `sendVoiceTurn` 这条路上到不了这个码（SDK 1.10 的文档：开关关闭时它落成普通的
  // 空文本 400 VALIDATION_ERROR），留着是给文字回合那条路兜底，也免得读者以为漏了。
  VOICE_TURNS_DISABLED: "语音回合这会儿关着，先用点选的题上课吧。",
  // 语音路径上最常见的一种：agent 这一版没声明 `voice.input`（比如刚被换回一期 revision），
  // 平台按「空文本且附件不像语音」拒掉，回的就是这个码 + 一句英文校验文案。孩子不该看到那句。
  VALIDATION_ERROR: "跟读这次没发出去，先用点选的题上课吧（老师这一版可能还没开语音）。",
  not_configured: "这个站点还没接上平台（缺 AGENTHUB token），先在本地看页面吧。",
  VOICE_INPUT_TOO_LONG: "这段录音太长了（超过 60 秒），短一点再读一次。",
  VOICE_AUDIO_UNREADABLE: "这段录音读不出内容，按住按钮重新录一次试试？",
  VOICE_TRANSCRIPT_EMPTY: "没听清你说的这句，再说一遍？",
  VOICE_TRANSCRIPTION_FAILED: "转写出错了，稍等一下再试一次。",
  VOICE_MODEL_NOT_AUTHORIZED: "这门课的语音还没配好，先用点选的题上课吧。",
  VOICE_MODEL_SERVICE_UNSUPPORTED: "这门课的语音还没配好，先用点选的题上课吧。",
  SESSION_TURN_IN_PROGRESS: "老师还在说话，等它说完再按。",
  SESSION_NOT_READY: "老师还没准备好，等一下再按。",
  NETWORK_ERROR: "网断了，等网络回来再试一次。",
  SESSION_REVIVING: "会话正在恢复，恢复好再按一次。",
  // 服务端 waitForTurn 的截止（120 s）；转写那一段也有自己的 15 s 超时，但那是平台内部的。
  SESSION_TURN_WAIT_TIMEOUT: "老师这次回得太慢了，再按一次试试。",
};

export function voiceErrorMessage(code: string | undefined, detail?: string): string {
  if (code && MESSAGES[code]) return MESSAGES[code];
  if (detail) return `${detail}${code ? `（${code}）` : ""}`;
  return code ? `这次没发出去（${code}），再试一次。` : "这次没发出去，再试一次。";
}
