/**
 * 实时语音的错误码：每个码在页面上说什么，以及哪些码要退回「按住说话」。
 *
 * 码有两个来源：站点换票口回的 HTTP 状态和 `error` 字段（平台的拒法原样透出），
 * 以及浏览器里 SDK 通过 `onError` 给的 code。
 *
 * 回落：换票回 409 / 503、WebSocket 建连失败、麦克风拿不到、连续两次 `NO_RESPONSE`。
 * 不回落：401 / 403 / 404 / 501（换一种说话方式也救不了）和会话还没就绪（让用户再点一次）。
 */

export interface TicketFailure {
  status: number;
  code?: string;
}

export function ticketFailureFallsBack(failure: TicketFailure): boolean {
  return failure.status === 409 || failure.status === 503;
}

export interface RealtimeFailure {
  code: string;
  retryable: boolean;
}

const CLIENT_FALLBACK_CODES: ReadonlySet<string> = new Set([
  // 建连
  "CONNECTION_FAILED",
  "CONNECT_TIMEOUT",
  "RECONNECT_EXHAUSTED",
  "INVALID_PROTOCOL",
  "INVALID_GATEWAY_URL",
  "INVALID_TICKET",
  // 麦克风 / AudioContext
  "AUDIO_SETUP_FAILED",
  "AUDIO_UNAVAILABLE",
  "AUDIO_RESUME_FAILED",
  "MICROPHONE_ENDED",
]);

/** 连着两次 `NO_RESPONSE` 才算线路不可用；单次是对方没说话。中间成功过一轮就 `reset()`。 */
export function createNoResponseStreak(): {
  observe(code: string): boolean;
  reset(): void;
} {
  let streak = 0;
  return {
    observe(code: string): boolean {
      if (code !== "NO_RESPONSE") return false;
      streak += 1;
      return streak >= 2;
    },
    reset(): void {
      streak = 0;
    },
  };
}

export function clientFailureFallsBack(failure: RealtimeFailure): boolean {
  return CLIENT_FALLBACK_CODES.has(failure.code);
}

export interface CallFailureContext {
  /** SDK 报的码。换票失败时 SDK 一律报 `CONNECTION_FAILED`，真正的原因在 `ticket` 里。 */
  code: string;
  /** 这一通换票失败的原因；`status: 0` 表示会话没等出来。 */
  ticket: TicketFailure | null;
  /** 这一通拿到过票没有：没拿到就超时是会话起得慢，不是连不上。 */
  ticketIssued: boolean;
  noResponseStreak: boolean;
}

/** fallback = 换成按住说话；retry = 让用户再点一次开始；ignore = 只提示；error = 给一句话，不回落。 */
export type CallFailureAction = "fallback" | "retry" | "ignore" | "error";

export function classifyCallFailure(ctx: CallFailureContext): { action: CallFailureAction; code?: string } {
  if (ctx.ticket) {
    // SESSION_NOT_READY 也是 409，但等一下就好，不回落。
    if (ctx.ticket.code === "SESSION_NOT_READY") return { action: "retry", code: ctx.ticket.code };
    if (ticketFailureFallsBack(ctx.ticket)) return { action: "fallback", code: ctx.ticket.code };
    return { action: "error", code: ctx.ticket.code };
  }
  if (ctx.code === "NO_RESPONSE") {
    return ctx.noResponseStreak
      ? { action: "fallback", code: ctx.code }
      : { action: "ignore", code: ctx.code };
  }
  if ((ctx.code === "CONNECT_TIMEOUT" || ctx.code === "CONNECTION_FAILED") && !ctx.ticketIssued) {
    return { action: "retry", code: ctx.code };
  }
  if (CLIENT_FALLBACK_CODES.has(ctx.code)) return { action: "fallback", code: ctx.code };
  return { action: "error", code: ctx.code };
}

const MESSAGES: Record<string, string> = {
  // 站点换票口
  visitor_required: "这个浏览器还没拿到身份，刷新一下页面再试。",
  session_not_found: "这条会话找不到了，刷新页面重新开始。",
  not_configured: "站点还没接上平台（缺 AGENTHUB token），先在本地看页面吧。",
  cross_origin_not_allowed: "换票请求被挡下了（不是从本站发起的），刷新页面再试。",
  bad_request: "这次请求没发对，刷新页面再试。",
  voice_ticket_failed: "换票没成功，稍等一下再试。",
  // 平台
  REALTIME_DISABLED: "这门课的实时通话还没在平台侧打开，先用按住说话练。",
  REALTIME_NOT_DECLARED: "这个 Agent 这一版没有声明实时语音，先用按住说话练。",
  REALTIME_NOT_CONFIGURED: "平台的实时语音网关还没配好，先用按住说话练。",
  SESSION_NOT_READY: "会话还没就绪，等一下再连。",
  // 页面自己造的码：会话没在限时内建出来
  SESSION_TIMEOUT: "会话还没建好。等一下再点一次「开始通话」。",
  // SDK
  CONNECTION_FAILED: "连不上实时语音网关。",
  CONNECT_TIMEOUT: "实时语音网关没在规定时间里应答。",
  RECONNECT_EXHAUSTED: "实时语音断了，重连也没成功。",
  RECONNECTING: "实时语音断了一下，正在重连…",
  INVALID_PROTOCOL: "实时语音的协议对不上（网关版本可能变了）。",
  INVALID_GATEWAY_URL: "平台给的回连地址不对。",
  INVALID_TICKET: "这张票不合格，换一张再试。",
  INVALID_AUDIO: "这条音频没法处理，再试一次。",
  INVALID_READY: "网关的应答不完整。",
  INVALID_MESSAGE: "网关发来一条读不懂的消息。",
  GATEWAY_ERROR: "网关这边出错了。",
  NO_RESPONSE: "对面没接上话，再说一句试试。",
  AUDIO_SETUP_FAILED: "麦克风没能打开（浏览器没给权限，或者设备被占着）。",
  AUDIO_UNAVAILABLE: "这个浏览器放不出实时语音需要的音频。",
  AUDIO_RESUME_FAILED: "音频被浏览器挂起了，再点一次开始。",
  AUDIO_PROCESSOR_FAILED: "音频处理这一台出错了，再试一次。",
  AUDIO_BACKPRESSURE: "声音发得太快，网速跟不上，重连一下。",
  MICROPHONE_ENDED: "麦克风被关掉了（可能别的应用抢走了）。",
  REALTIME_STOPPED: "通话已经结束了。",
};

export const FALLBACK_NOTICE = "实时通话不可用，已切换为按住说话";

export function realtimeErrorMessage(code: string | undefined): string {
  if (code && MESSAGES[code]) return MESSAGES[code];
  return code ? `实时通话出了点问题（${code}）。` : "实时通话出了点问题，再试一次。";
}
