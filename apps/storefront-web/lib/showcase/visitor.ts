"use client";

/**
 * 访客身份在浏览器这边的样子。
 *
 * **身份本身浏览器拿不到**：它由服务端签发，放在 httpOnly 的 `ahv` cookie 里（`lib/backend/visitor-binding.ts`），
 * 同源的 fetch 自动带上；购物车、记忆、偏好和订单的路由都以它为准，请求里不再带 `X-CMA-User` 或 `subject_id`。
 * 之前 id 存在 localStorage、显示在页面上、放在请求头里——谁拿到别人的 id 就能读写别人的购物车和记忆。
 *
 * 页面拿到的只有**代号**（`tag`）：身份的 HMAC 前 12 位，用来显示和给预热句柄做比对。服务端从不认它，
 * 截图出去不是凭据。
 *
 * 顺序：页面先 `ensureVisitor()` 拿到 cookie，再发购物车请求、建会话、预热。
 *
 * 当前代号只有一份，存在本模块里（`useVisitorTag` 订阅它）：页面挂载时拿到的、购物会话采纳 EUID 后换的、
 * cookie 失效后重拿的，都从这里发出去，显示、购物车、记忆、预热句柄跟着同一个值走。
 *
 * 会写 `ahv` 的两种请求（`/api/visitor`、建会话）也都从这里发，排成一队，一次只飞一笔（`enqueueWrite`）。
 */

import { useEffect, useState } from "react";

const KEY = "agenthub-showcase-visitor";

function makeLocalKey(): string {
  return `v-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * 本机进度（英语小课、情景对话）在 localStorage 里的 key。**不是身份，不发给服务端。**
 * 沿用之前访客 id 的那个 localStorage 项，已有的本机进度不丢。服务端渲染时返回 null。
 */
export function readLocalProgressKey(): string | null {
  if (typeof window === "undefined") return null;
  try {
    const existing = window.localStorage.getItem(KEY);
    if (existing) return existing;
    const created = makeLocalKey();
    window.localStorage.setItem(KEY, created);
    return created;
  } catch {
    // 隐私模式下 localStorage 会抛：当次页面内一致，刷新后从零开始。
    return makeLocalKey();
  }
}

let pending: Promise<string | null> | null = null;
let inflight: Promise<string | null> | null = null;
let current: string | null = null;
const listeners = new Set<(tag: string) => void>();
/** 写 `ahv` 的请求排成的那一队的队尾，见 `enqueueWrite`。 */
let tail: Promise<unknown> = Promise.resolve();

function publish(tag: string): void {
  if (tag === current) return;
  current = tag;
  for (const listener of listeners) listener(tag);
}

/** 换代号。只在排队的写请求里调（`enqueueWrite`），代号的变化顺序因此和 cookie 的写入顺序一致。 */
function noteVisitorTag(tag: string): void {
  pending = Promise.resolve(tag);
  publish(tag);
}

const noop = () => undefined;

/**
 * 页面上会写 `ahv` 的请求排成一队，一次只飞一笔：`/api/visitor`（续期、401 后重拿、
 * 换身份）和建会话的 POST（购物侧采纳 EUID 时改写 `ahv`）。浏览器按响应到达的顺序落 Set-Cookie，两笔同时飞时
 * 谁晚到谁赢，页面上的代号却按另一套顺序换：换身份被晚到的会话响应撤回，或者 cookie 落在重拿的身份上、页面
 * 显示的是 EUID。这些都是同一类问题，所以不逐个窗口打补丁，改成排队：
 *   - 后一笔发出时带的是前一笔写下的 cookie，服务端照它续期、采纳或换新，最后一笔的响应就是最终身份；
 *   - 代号在 `task` 里换，读完响应体才出队，所以代号的变化顺序和 cookie 的写入顺序一致。
 * 前一笔抛错（网络断）不挡后面的。代价：401 后的重拿要等在飞的建会话落地（池 miss 时冷启要几秒）。
 * 队只在这一个页面里：两个标签页各排各的。
 */
function enqueueWrite<T>(task: () => Promise<T>): Promise<T> {
  const run = tail.then(task);
  tail = run.then(noop, noop);
  return run;
}

async function requestVisitor(reset: boolean): Promise<string | null> {
  try {
    const res = await fetch("/api/visitor", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(reset ? { reset: true } : {}),
    });
    if (!res.ok) return null;
    const data = (await res.json()) as { tag?: unknown };
    return typeof data.tag === "string" ? data.tag : null;
  } catch {
    return null;
  }
}

/**
 * 确保这个浏览器有访客 cookie，返回代号；拿不到（站点没配、cookie 被禁、网络错）返回 null。
 * 一个页面只发一次；`force` 用于路由回了 401 `visitor_required`（cookie 被清或过期）时重新拿。
 */
export function ensureVisitor(force = false): Promise<string | null> {
  // 已有一笔在飞或在排队就跟着它：几个请求同时 401 时各自 force，会签出几个身份，后到的 Set-Cookie 覆盖先到的，
  // 重发的请求落在哪个身份上说不准（实测见过「我的」页两个 401 → 两次 /api/visitor）。
  if (inflight) return inflight;
  if (pending && !force) return pending;
  // 排在队里，响应总是最后一次写入：它的代号照登。没有「被取代」的情形——排在它前面的建会话已经落地，
  // 这一笔带着那次写下的 cookie 发出。
  const attempt: Promise<string | null> = enqueueWrite(async () => {
    const tag = await requestVisitor(false);
    if (inflight === attempt) inflight = null;
    if (tag) noteVisitorTag(tag);
    // 失败不缓存：下一个调用方重试。排队期间别的写入已经换过代号的，留着那一个。
    else if (pending === attempt) pending = null;
    return tag;
  });
  inflight = attempt;
  pending = attempt;
  return attempt;
}

/**
 * 「换一个身份」：服务端签一个新身份，返回新代号；失败返回 null。旧身份的购物车和记忆这个浏览器再也认领不到。
 *
 * 排在在飞的写请求后面（`enqueueWrite`）：挂载时的续期、401 后的重拿、购物会话的采纳，晚于换身份到达时都会
 * 把 cookie 写回别的身份，换身份就被静默撤回。换身份这一笔在排队时
 * 就记成 `inflight`，期间别的调用方跟着它，不再另发。
 */
export function resetVisitor(): Promise<string | null> {
  const attempt: Promise<string | null> = enqueueWrite(async () => {
    const tag = await requestVisitor(true);
    if (inflight === attempt) inflight = null;
    if (tag) noteVisitorTag(tag);
    return tag;
  });
  inflight = attempt;
  return attempt;
}

/** `POST /api/agenthub/session` 的响应体（页面用到的几个字段）。 */
export type SessionCreated = {
  agentHubSessionId?: string;
  status?: string;
  /** 购物侧采纳平台 EUID 后，访客 cookie 换成了 EUID，这是新代号。 */
  visitorTag?: string;
  detail?: string;
};

/**
 * 建会话。购物侧在这个响应里把 `ahv` 改成平台 EUID（`lib/backend/visitor-binding.ts` 的 `withVisitorCookie`），
 * 所以和 `/api/visitor` 排同一队，读完响应体、换完代号才出队。别的 agent 不改 `ahv`，也走这里，页面就不用再
 * 判一次哪个 agent 会改。响应体不是 JSON（网关的错误页）时抛错，同 `res.json()`。
 */
export function postAgentSession(body: { agent: string; chatSessionId: string }): Promise<{ status: number; data: SessionCreated }> {
  return enqueueWrite(async () => {
    const res = await fetch("/api/agenthub/session", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const data = (await res.json()) as SessionCreated;
    if (typeof data.visitorTag === "string" && data.visitorTag) noteVisitorTag(data.visitorTag);
    return { status: res.status, data };
  });
}

/** 订阅当前代号（`useVisitorTag` 用它）；已有代号时立刻回调一次。返回取消订阅。 */
export function subscribeVisitorTag(listener: (tag: string) => void): () => void {
  listeners.add(listener);
  if (current) listener(current);
  return () => {
    listeners.delete(listener);
  };
}

/**
 * 带访客身份的 POST（购物车、记忆、偏好、订单）。身份在 cookie 里，请求不带 id。
 * 回 401 `visitor_required`（cookie 被清、过期、站点换了 token）时重拿一次身份再发一次——新身份，数据从空开始。
 */
export async function visitorPost(path: string, body: unknown): Promise<Response> {
  const send = () => fetch(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const res = await send();
  if (res.status !== 401 || !(await ensureVisitor(true))) return res;
  return send();
}

/** 当前访客代号；挂载时确保有 cookie。null = 还没拿到（或拿不到），购物车和记忆先不读。 */
export function useVisitorTag(): string | null {
  const [tag, setTag] = useState<string | null>(current);
  useEffect(() => {
    const off = subscribeVisitorTag(setTag);
    void ensureVisitor();
    return off;
  }, []);
  return tag;
}
