/**
 * 访客身份：服务端签发，放在签名的 httpOnly cookie `ahv` 里。
 *
 * 为什么要它：购物车、记忆、偏好按访客 id 分（`/api/backend/*` 读 `X-CMA-User`，`/api/memory/*` 读
 * body 的 `subject_id`），之前这个 id 由浏览器自己报——谁拿到别人的 id（日志、截图、页面上显示的那串），
 * 谁就能读写别人的购物车和记忆，id 是 bearer 凭据。
 *
 * - **发**：`POST /api/visitor`（页面挂载时调一次；没 cookie 就签新身份，有就续期；`reset` = 换一个人），
 *   以及购物侧 `POST /api/agenthub/session`（会话采纳平台 EUID 后，cookie 改成 EUID）。值是
 *   `<id>.<exp>.<mac>`，HttpOnly、SameSite=Strict、Path=/api，本机以外带 Secure（同会话归属 cookie）。
 *   浏览器 JS 读不到 id，响应里不回 id，页面上只显示 `logTag` 代号。
 * - **认**（`resolveVisitor`），三类请求：
 *   1. 带有效 `ahv`：用 cookie 里的 id。请求自己报的 id（header / body）一律忽略——伪造别人的 id 只会落在自己名下。
 *   2. 没有有效 `ahv`，但带 `Sec-Fetch-Site`：这是浏览器（只有浏览器发这个头，页面脚本去不掉），回 401，
 *      不看它报的 id。
 *   3. 两样都没有：沙箱里 stdio MCP 的回调（`HttpStorefrontBackend` / `HttpMemoryStore`，它们带不了访客的
 *      cookie）。认它报的 id，但只认高熵形状（平台 EUID 和本模块签的 id 同形，约 108 bit），外加 eval 会话的
 *      `eval-user`，非 prod 再加本机 agent dev 的 `demo-user`。旧的 `v-…`（约 31 bit）和其他形状一律 401。
 *   第 3 类站点分不出沙箱和别的客户端（`BACKEND_TOKEN` 没配，配它要改 agent 定义）；这一类的
 *   安全靠 id 拿不到：高熵、不进浏览器 JS、不进响应、不上屏、日志里只有 HMAC 代号（`lib/log-id.ts`）。
 * - **不靠进程内状态**：验签只要密钥。密钥从 `AGENTHUB_TOKEN` 派生，label 与会话归属不同，
 *   不新增 env；两个副本算出同一把。按密钥列表写：第一把签，全部能验。
 * - 没配 token：签不出也验不过——`/api/visitor` 回 501，浏览器请求全部 401。
 *
 * **派生出的密钥和 cookie 值不进任何日志**：本模块不打日志，调用方只记 `idTag`。
 * 用例与变异自测：`scripts/visitor-binding/check.mjs`。
 */

import { createHmac, randomInt, timingSafeEqual } from "node:crypto";
import { secureAttr } from "@/lib/agenthub/session-binding";

export const VISITOR_COOKIE = "ahv";
/** 30 天：跨访问保留身份（购物车、记忆跟着走）。每次 `/api/visitor` 续期。 */
export const VISITOR_TTL_SECONDS = 30 * 24 * 60 * 60;

const LABEL = "agenthub-showcase/visitor-binding/v1";
/**
 * 高熵 id 的形状：`<前缀>_<21 位小写字母数字，首位字母>`。平台预热池给会话生成的 EUID 就是这个形状
 * （前缀 `^[a-z][a-z0-9]{0,11}$`），本模块签的 `vis_…` 用同一套字母表。
 */
const HIGH_ENTROPY_ID_RE = /^[a-z][a-z0-9]{0,11}_[a-z][a-z0-9]{20}$/;
/** `<id>.<exp 秒>.<mac 128 bit 的 base64url>` */
const VALUE_RE = /^([a-z][a-z0-9]{0,11}_[a-z][a-z0-9]{20})\.(\d{1,12})\.([A-Za-z0-9_-]{22})$/;
const MAC_BYTES = 16;
const ID_ALPHABET = "0123456789abcdefghijklmnopqrstuvwxyz";
/** eval 会话的固定身份（`agenthub/agents/cma-shopping/agent.yaml` 的 `CMA_END_USER_ID`）。 */
const EVAL_USER = "eval-user";
/** stdio server 两个 env 都没有时的缺省（本机 `agenthub agent dev`）。prod 上不认。 */
const DEMO_USER = "demo-user";

let derived: { token: string; keys: Buffer[] } | null = null;

function bindingKeys(): Buffer[] {
  const token = process.env.AGENTHUB_TOKEN;
  if (!token) return [];
  if (derived?.token !== token) {
    derived = { token, keys: [createHmac("sha256", token).update(LABEL).digest()] };
  }
  return derived.keys;
}

function mac(key: Buffer, id: string, exp: number): Buffer {
  return createHmac("sha256", key).update(`v1\n${id}\n${exp}`).digest().subarray(0, MAC_BYTES);
}

/**
 * 是不是本模块认的身份形状（平台 EUID / 本模块签的 `vis_…`）。购物会话采纳 EUID 前先问它：形状不符的 EUID
 * 发不进 cookie，沙箱拿它回调也会被 `resolveVisitor` 拒——采纳了就是身份分裂。
 */
export function isVisitorId(id: string): boolean {
  return HIGH_ENTROPY_ID_RE.test(id);
}

/** 能签发身份吗（配了 token）。 */
export function canIssueVisitor(): boolean {
  return bindingKeys().length > 0;
}

/** 一个新身份：`vis_` + 21 位，CSPRNG，约 108 bit。 */
export function mintVisitorId(): string {
  let id = ID_ALPHABET[10 + randomInt(26)];
  for (let i = 1; i < 21; i++) id += ID_ALPHABET[randomInt(ID_ALPHABET.length)];
  return `vis_${id}`;
}

/** 请求里的 `ahv`（同名取第一个）。 */
function readCookie(req: Request): string | null {
  const raw = req.headers.get("cookie");
  if (!raw) return null;
  for (const part of raw.split(";")) {
    const eq = part.indexOf("=");
    if (eq < 0) continue;
    if (part.slice(0, eq).trim() === VISITOR_COOKIE) return part.slice(eq + 1).trim();
  }
  return null;
}

/** cookie 里验过签、没过期的访客 id；没有或验不过返回 null。 */
export function readVisitor(req: Request, now = Date.now()): string | null {
  const value = readCookie(req);
  if (!value) return null;
  const parsed = VALUE_RE.exec(value);
  if (!parsed) return null;
  const [, id, expRaw, macRaw] = parsed;
  const exp = Number(expRaw);
  if (exp * 1000 <= now) return null;
  const presented = Buffer.from(macRaw, "base64url");
  if (presented.length !== MAC_BYTES) return null;
  return bindingKeys().some((key) => timingSafeEqual(mac(key, id, exp), presented)) ? id : null;
}

/** 第 3 类请求（沙箱回调）报的 id 认不认。 */
function acceptableClaim(claimed: unknown): string | null {
  if (typeof claimed !== "string") return null;
  if (HIGH_ENTROPY_ID_RE.test(claimed)) return claimed;
  if (claimed === EVAL_USER) return claimed;
  if (claimed === DEMO_USER && process.env.AGENTHUB_STAGE !== "production") return claimed;
  return null;
}

/**
 * 这个请求是哪个访客的。`claimed` 是请求自己报的 id（backend 路由的 `X-CMA-User`、memory 路由的
 * `subject_id`），只在第 3 类（沙箱回调）里用。返回 null = 回 `visitorRequired()`。
 */
export function resolveVisitor(req: Request, claimed: unknown, now = Date.now()): string | null {
  const fromCookie = readVisitor(req, now);
  if (fromCookie) return fromCookie;
  if (req.headers.has("sec-fetch-site")) return null;
  return acceptableClaim(claimed);
}

/** 认不出访客时的唯一回答。浏览器收到它就重跑一次 `/api/visitor`。 */
export function visitorRequired(): Response {
  return Response.json({ error: "visitor_required" }, { status: 401, headers: { "cache-control": "no-store" } });
}

/** 给响应带上这个访客的 cookie（新签或续期）。没配 token 时不发。 */
export function withVisitorCookie(res: Response, req: Request, id: string, now = Date.now()): Response {
  const [key] = bindingKeys();
  if (!key || !HIGH_ENTROPY_ID_RE.test(id)) return res;
  const exp = Math.floor(now / 1000) + VISITOR_TTL_SECONDS;
  res.headers.append(
    "set-cookie",
    `${VISITOR_COOKIE}=${id}.${exp}.${mac(key, id, exp).toString("base64url")}; Path=/api; HttpOnly; SameSite=Strict${secureAttr(req)}; Max-Age=${VISITOR_TTL_SECONDS}`,
  );
  return res;
}
