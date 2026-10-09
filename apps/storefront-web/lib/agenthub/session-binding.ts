/**
 * 会话归属：站点交给浏览器的每个 AgentHub 会话，都配一个只有这个浏览器拿得到的签名 cookie。
 *
 * 为什么要它：`/api/agenthub/*` 这些路由收到请求里的 session id 就去调平台，不问会话是谁建的——谁拿到
 * 一个 id（日志、截图、门户链接），就能读那个会话、往里发话，id 成了 bearer 凭据。
 *
 * - **发**：只有两处把 id 交给浏览器——`POST /api/agenthub/session`（池里的会话在这一刻被领走）和
 *   `POST /api/agenthub/session/prewarm`。它们在同一个响应里下发 `ahs_<sid>=<exp>.<mac>`，
 *   HttpOnly、SameSite=Strict、Path=/api，本机以外带 Secure。一个会话一个 cookie 名：同一个浏览器并发建会话（英语页的
 *   主会话和出题会话、跨 agent 预热）各写各的，互不覆盖。
 * - **验**：收 session id 的路由在调平台**之前**调 `ownsSession`，不过就回 `sessionNotFound()`——404、
 *   固定 body。没 cookie、别人的 id、伪造、过期、id 格式不对都是同一个回答，所以不存在的会话和别人的
 *   会话分不出来。
 * - **不靠进程内状态**：验签只要密钥。密钥从 `AGENTHUB_TOKEN` 派生（不新增 env），
 *   两个副本读同一份 env、算出同一把；拿到这个 token 的人本来就能直接读任何会话，这里不是更弱的一环。
 *   token 一换，所有绑定失效，页面走 `useAgentConversation` 的重建。按密钥列表写（第一把签、全部能验），
 *   以后要独立轮换就在 `bindingKeys` 里加一把。
 *
 * **派生出的密钥和 cookie 值不进任何日志**：本模块不打日志，调用方只记 session id。
 * 用例与变异自测：`scripts/session-binding/check.mjs`。
 */

import { createHmac, timingSafeEqual } from "node:crypto";

export const BINDING_COOKIE_PREFIX = "ahs_";
/** 一个绑定的有效期。页面上的会话撑不过这么久；本机存下的单元 3 过了期取读音会 404，退本机语音。 */
export const BINDING_TTL_SECONDS = 24 * 60 * 60;
/** 一个浏览器最多同时留这么多绑定（单个约 75 字节），再建会话时把最旧的清掉。 */
export const MAX_BINDINGS = 32;

const LABEL = "agenthub-showcase/session-binding/v1";
const SESSION_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
/** `<exp 秒>.<mac 128 bit 的 base64url>` */
const VALUE_RE = /^(\d{1,12})\.([A-Za-z0-9_-]{22})$/;
const MAC_BYTES = 16;

let derived: { token: string; keys: Buffer[] } | null = null;

/** 签用第一把，验时每一把都试。没配 token 时是空表：什么都验不过，也什么都不发。 */
function bindingKeys(): Buffer[] {
  const token = process.env.AGENTHUB_TOKEN;
  if (!token) return [];
  if (derived?.token !== token) {
    derived = { token, keys: [createHmac("sha256", token).update(LABEL).digest()] };
  }
  return derived.keys;
}

function mac(key: Buffer, sessionId: string, exp: number): Buffer {
  return createHmac("sha256", key).update(`v1\n${sessionId}\n${exp}`).digest().subarray(0, MAC_BYTES);
}

/** 平台的 session id 是小写 UUID；大小写不同的同一个 id 当同一个，别的一律不认。 */
function normalizeId(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const id = raw.trim().toLowerCase();
  return SESSION_ID_RE.test(id) ? id : null;
}

/** 请求里带的绑定：session id → cookie 值。名字后半不是 session id 的不算；同名的取第一个。 */
function readBindings(req: Request): Map<string, string> {
  const out = new Map<string, string>();
  const raw = req.headers.get("cookie");
  if (!raw) return out;
  for (const part of raw.split(";")) {
    const eq = part.indexOf("=");
    if (eq < 0) continue;
    const name = part.slice(0, eq).trim();
    if (!name.startsWith(BINDING_COOKIE_PREFIX)) continue;
    const id = name.slice(BINDING_COOKIE_PREFIX.length);
    if (SESSION_ID_RE.test(id) && !out.has(id)) out.set(id, part.slice(eq + 1).trim());
  }
  return out;
}

/** 这个请求的浏览器是不是建了 `sessionId` 这个会话（且绑定没过期）。 */
export function ownsSession(req: Request, sessionId: unknown, now = Date.now()): boolean {
  const id = normalizeId(sessionId);
  if (!id) return false;
  const value = readBindings(req).get(id);
  if (!value) return false;
  const parsed = VALUE_RE.exec(value);
  if (!parsed) return false;
  const exp = Number(parsed[1]);
  if (exp * 1000 <= now) return false;
  const presented = Buffer.from(parsed[2], "base64url");
  if (presented.length !== MAC_BYTES) return false;
  return bindingKeys().some((key) => timingSafeEqual(mac(key, id, exp), presented));
}

/**
 * 归属没验过时的唯一回答。不回 403：403 等于告诉对方「这个会话存在，只是不归你」。
 * code 和平台的 404（`TURN_AUDIO_NOT_FOUND` 等）不同名，页面据此分辨「会话丢了要重建」和「这一轮没音频」。
 */
export function sessionNotFound(): Response {
  return Response.json({ error: "session_not_found" }, { status: 404, headers: { "cache-control": "no-store" } });
}

/** 本机开发的主机名：只有它们不加 `Secure`（有的浏览器不收 http 下发的 Secure cookie，本机走查会建不起会话）。 */
const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

/**
 * 除本机以外一律 `Secure`，按 **Host 头**判本机：
 * - 不看 `x-forwarded-proto`：部署在 TLS 终结的反向代理后面时，它到 pod 时不是 `https`——按它判，线上的 `Set-Cookie` 都不会带 Secure（实测）。
 * - 不看 `req.url`：`next start` 不带 `-H`（prod 就这么起）时，route handler 里的 `req.url` 恒为
 *   `http://localhost:<port>`，跟请求的 Host 无关（本机实测）。按它判，prod 也会被当成本机。
 * - prod 上 pod 收到的 Host 是公网主机名：跨站挡板「Origin 与 Host 比」那一支在 prod 上放行同源 Origin、挡住别的
 *   （`lib/backend/guards.ts`）。缺 Host 或解析不了的，一律带 Secure。
 * 伪造 Host 为 localhost，只会让发这个请求的人自己拿到一个不带 Secure 的 cookie；经网关也路由不到本服务。
 */
export function secureAttr(req: Request): string {
  const host = req.headers.get("host");
  if (!host) return "; Secure";
  let hostname: string;
  try {
    hostname = new URL(`http://${host}`).hostname;
  } catch {
    return "; Secure";
  }
  return LOCAL_HOSTS.has(hostname) ? "" : "; Secure";
}

/** 已经带了 `MAX_BINDINGS` 个绑定时，按到期时间挑出要清掉的最旧几个（新建的这个不算）。 */
function evictable(bindings: Map<string, string>, keep: string): string[] {
  const others = [...bindings].filter(([id]) => id !== keep);
  const excess = others.length - (MAX_BINDINGS - 1);
  if (excess <= 0) return [];
  const expOf = (value: string) => Number(VALUE_RE.exec(value)?.[1] ?? 0);
  return others
    .sort((a, b) => expOf(a[1]) - expOf(b[1]))
    .slice(0, excess)
    .map(([id]) => id);
}

/**
 * 把会话交给浏览器的那个响应，带上这个会话的绑定 cookie（和要清掉的旧绑定）。
 * 没配 token 时不发：调用方在那之前已经因为「未接入」回 501 了。
 */
export function withSessionBinding(res: Response, req: Request, sessionId: string, now = Date.now()): Response {
  const id = normalizeId(sessionId);
  const [key] = bindingKeys();
  if (!id || !key) return res;
  const exp = Math.floor(now / 1000) + BINDING_TTL_SECONDS;
  const attrs = `Path=/api; HttpOnly; SameSite=Strict${secureAttr(req)}`;
  res.headers.append(
    "set-cookie",
    `${BINDING_COOKIE_PREFIX}${id}=${exp}.${mac(key, id, exp).toString("base64url")}; ${attrs}; Max-Age=${BINDING_TTL_SECONDS}`,
  );
  for (const old of evictable(readBindings(req), id)) {
    res.headers.append("set-cookie", `${BINDING_COOKIE_PREFIX}${old}=; ${attrs}; Max-Age=0`);
  }
  return res;
}
