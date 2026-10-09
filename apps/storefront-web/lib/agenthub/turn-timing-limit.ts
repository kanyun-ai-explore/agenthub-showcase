/**
 * `POST /api/agenthub/turn-timing` 的限流：进程内存里的固定窗口计数，按来源 IP
 * 和会话各数一份，再加一个总量上限。只管这一个接口。
 *
 * 为什么要限：这个接口写日志。正常页面每个语音回合报一次，别的程序照着格式刷，就能往日志里
 * 灌行。站点别的 `/api` 都没有服务端限流，没有现成的可以复用：语音的「每分钟 10 次」是页面上
 * 的本地闸（`lib/agenthub/voice-recording.ts`），平台的 429 在平台那一侧。
 *
 * 阈值（每个 60 s 窗口）：
 * - 同一会话 12 次：语音回合每会话每分钟最多 10 个（页面本地闸，平台 429 兜底），每个回合报
 *   一次，留 2 次余量。校验通过之后才数。
 * - 同一 IP 60 次：同一个出口后面可能有好几个人。读请求体之前就数，无效请求也算。
 * - 全进程 600 次：总量上限，按 IP 放行的请求都算。它同时是两张计数表的大小上限：表里只在
 *   放行时加键，一个窗口最多放行 600 次，随机造会话 ID、换 IP 都撑不大内存。
 *
 * 边界：计数在单个进程的内存里，多副本时每个副本各数各的（上限乘副本数），进程重启清零。
 * IP 取 `x-forwarded-for` 的第一段，客户端可以自己填：伪造它只绕得过按 IP 的那一份，按会话和
 * 总量的两份照样生效。固定窗口（不是滑动窗口），窗口交界前后最多放过两倍。
 *
 * 纯逻辑，时钟由调用方传入，`scripts/roleplay-stream/check.mjs` 直接 import 跑用例和变异。
 */

export interface TurnTimingLimits {
  windowMs: number;
  perSession: number;
  perIp: number;
  total: number;
}

export const TURN_TIMING_LIMITS: TurnTimingLimits = {
  windowMs: 60_000,
  perSession: 12,
  perIp: 60,
  total: 600,
};

export interface TurnTimingLimiter {
  /** 读请求体之前：这个 IP 和总量本窗都还有余量，就各记一次、放行。 */
  admitIp(ip: string, now: number): boolean;
  /** 校验通过之后、写日志之前：这个会话本窗还有余量，就记一次、放行。 */
  admitSession(sessionId: string, now: number): boolean;
  /** 离本窗结束还有多少毫秒（`Retry-After` 用）。 */
  retryAfterMs(now: number): number;
  /** 本窗的计数（用例用来看计数表有没有被撑大）。 */
  size(): { ips: number; sessions: number; total: number };
}

export function createTurnTimingLimiter(limits: TurnTimingLimits = TURN_TIMING_LIMITS): TurnTimingLimiter {
  let windowStart = Number.NEGATIVE_INFINITY;
  let total = 0;
  const byIp = new Map<string, number>();
  const bySession = new Map<string, number>();

  /** 到了新窗口就清零（时钟往回走也清零，免得卡死在一个永远不结束的窗口里）。 */
  const roll = (now: number) => {
    if (now - windowStart < limits.windowMs && now >= windowStart) return;
    windowStart = now;
    total = 0;
    byIp.clear();
    bySession.clear();
  };

  return {
    admitIp(ip, now) {
      roll(now);
      const used = byIp.get(ip) ?? 0;
      // 先看这个 IP：一个 IP 刷满了自己那一份，不再占总量，别人的上报照常进来。
      if (used >= limits.perIp) return false;
      if (total >= limits.total) return false;
      total += 1;
      byIp.set(ip, used + 1);
      return true;
    },
    admitSession(sessionId, now) {
      roll(now);
      const used = bySession.get(sessionId) ?? 0;
      if (used >= limits.perSession) return false;
      bySession.set(sessionId, used + 1);
      return true;
    },
    retryAfterMs(now) {
      return Math.max(0, windowStart + limits.windowMs - now);
    },
    size() {
      return { ips: byIp.size, sessions: bySession.size, total };
    },
  };
}
