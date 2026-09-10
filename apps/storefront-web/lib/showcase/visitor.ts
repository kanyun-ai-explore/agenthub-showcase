"use client";

/**
 * 每个浏览器一个本地访客 id，存在 localStorage —— 现在只是**冷启回退**。
 *
 * 会话真正用的身份是平台的终端用户身份（EUID）：命中预热池时由平台在暖机阶段铸好，
 * 建会话后从 `conversation.userId` 读回（`app/api/agenthub/session/route.ts`）；只有
 * 会话没拿到 EUID 时才用这里的 id 以 `user.id` 冷启。agent 侧 `memory_subject` 取的是
 * `session.user_id`（shopping_agent/executor.py，沙箱内来自 `PILOT_END_USER_ID`），
 * 所以会话的 id 一处生效三处：购物车按它分、记忆按它分、`get_preferences` 注入的
 * `saved_memory` 也按它取——页面这边 `X-CMA-User` 必须跟着会话的那个 id 走。
 *
 * 之前所有访客共用 `demo-user`：两个人同时看演示会互相看到对方加的商品，
 * 记忆也是同一份，agent 记住的「消费习惯」是所有人混在一起的，等于没有。
 */

const KEY = "agenthub-showcase-visitor";

function makeId(): string {
  return `v-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

/** 服务端渲染时没有 localStorage，返回 null；调用方在 effect 里再取。 */
export function readVisitorId(): string | null {
  if (typeof window === "undefined") return null;
  try {
    const existing = window.localStorage.getItem(KEY);
    if (existing) return existing;
    const created = makeId();
    window.localStorage.setItem(KEY, created);
    return created;
  } catch {
    // 隐私模式下 localStorage 会抛。退化成一次性 id：当次会话内一致，
    // 刷新后换人——比整个页面报错好。
    return makeId();
  }
}

/** 会话采纳了平台 EUID 后记下来：下次来访以它为本地 id，购物车/记忆再由服务端搬到
 *  下一个会话的 EUID 名下，跨访问连续。 */
export function rememberVisitorId(id: string): void {
  try {
    window.localStorage.setItem(KEY, id);
  } catch {
    // 隐私模式：记不住就记不住，本次会话内仍一致
  }
}

/** 清掉本地身份 = 换一个人。用于「忘掉我」——调用方随后重载页面开新会话，购物车和记忆一起归零。 */
export function resetVisitorId(): string {
  const next = makeId();
  try {
    window.localStorage.setItem(KEY, next);
  } catch {
    // 同上，忽略
  }
  return next;
}

/** 访客身份要跟着每一个后端请求走，否则读到的是别人的车。 */
export function visitorHeaders(visitorId: string | null): Record<string, string> {
  return visitorId ? { "X-CMA-User": visitorId } : {};
}
