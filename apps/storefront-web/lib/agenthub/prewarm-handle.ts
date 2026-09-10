"use client";

/**
 * 跨 agent 预热的浏览器侧句柄。
 *
 * 站点 2 副本、服务端 .data 是 pod 本地——预热句柄只能存浏览器，存服务端等于存进了
 * 一个 50% 概率接不到的盒子里。平台空闲回收 30 min，句柄最大年龄取 25 min，
 * 确保切课那一刻会话还没被平台回收。
 */

export interface PrewarmHandle {
  sessionId: string;
  userId: string;
  agent: string;
  createdAt: number;
}

/** 平台空闲回收 30 min，留 5 min 余量，句柄超过这个年龄视为不可用。 */
export const PREWARM_MAX_AGE_MS = 25 * 60 * 1000;

const keyFor = (agent: string) => `agenthub:prewarm:${agent}`;

/** 纯判断：agent 与 userId 都匹配，且没超龄。 */
export function isHandleUsable(h: PrewarmHandle, agent: string, userId: string, now: number): boolean {
  return h.agent === agent && h.userId === userId && now - h.createdAt < PREWARM_MAX_AGE_MS;
}

/** 读一个 agent 的预热句柄；解析失败 / 不可用 / 没有一律返回 null（并清掉）。 */
export function readPrewarmHandle(agent: string, userId: string, now = Date.now()): PrewarmHandle | null {
  let raw: string | null = null;
  try {
    raw = window.sessionStorage.getItem(keyFor(agent));
  } catch {
    return null;
  }
  if (!raw) return null;
  let handle: PrewarmHandle;
  try {
    handle = JSON.parse(raw) as PrewarmHandle;
  } catch {
    clearPrewarmHandle(agent);
    return null;
  }
  if (
    typeof handle?.sessionId !== "string" ||
    typeof handle?.userId !== "string" ||
    typeof handle?.agent !== "string" ||
    typeof handle?.createdAt !== "number"
  ) {
    clearPrewarmHandle(agent);
    return null;
  }
  if (!isHandleUsable(handle, agent, userId, now)) {
    clearPrewarmHandle(agent);
    return null;
  }
  return handle;
}

/** 存一个预热句柄；sessionStorage 不可用时静默忽略。 */
export function writePrewarmHandle(h: PrewarmHandle): void {
  try {
    window.sessionStorage.setItem(keyFor(h.agent), JSON.stringify(h));
  } catch {
    // 隐私模式 / 被禁用的 sessionStorage：记不住就不记，本页会话内不影响
  }
}

/** 清掉一个 agent 的预热句柄（命中、失效、换身份都要清，别留着误导下次）。 */
export function clearPrewarmHandle(agent: string): void {
  try {
    window.sessionStorage.removeItem(keyFor(agent));
  } catch {
    // 同上，忽略
  }
}
