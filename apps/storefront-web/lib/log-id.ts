/**
 * 日志里的标识一律写成 HMAC 代号。
 *
 * 为什么不是 sha256：浏览器本地访客 id（`v-<时间>-<6 位>`）的随机部分只有约 31 bit，日志里写它的
 * sha256 前 12 位，按日志时间就能离线把原值反推出来；原值是 `X-CMA-User`，拿到就能读写那个访客的
 * 购物车和记忆。带密钥的 HMAC 没有密钥就反推不了。
 *
 * - 密钥从 `AGENTHUB_TOKEN` 派生，label 与会话归属（`session-binding/v1`）、访客归属（`visitor-binding/v1`）
 *   都不同（不新增 env）。两个副本读同一份 env，算出同一把，日志在 pod 之间对得上；
 *   不用进程随机密钥，否则两个 pod 的日志对不上。
 * - 没配 token 时代号是 `?`：不退回 sha256，也不写原值。
 * - 派生出的密钥不进任何日志；本模块不打日志。
 *
 * 出口：站点自己的日志行（`idTag`），以及页面上显示的访客代号（`/api/visitor` 返回的 `tag`）。代号只用来对日志，
 * 服务端从不把它当身份认。
 */

import { createHmac } from "node:crypto";

const LABEL = "agenthub-showcase/log-id/v1";
const TAG_HEX = 12;

let derived: { token: string; key: Buffer } | null = null;

function logKey(): Buffer | null {
  const token = process.env.AGENTHUB_TOKEN;
  if (!token) return null;
  if (derived?.token !== token) derived = { token, key: createHmac("sha256", token).update(LABEL).digest() };
  return derived.key;
}

/** 一个标识的日志代号：HMAC-SHA256 前 12 位 hex。同一个 id 在各行、各副本里一致；没配 token 时是 `?`。 */
export function logTag(id: string): string {
  const key = logKey();
  if (!key) return "?";
  return createHmac("sha256", key).update(id).digest("hex").slice(0, TAG_HEX);
}

/** `<kind:代号>`，日志行里引用一个标识时用它。 */
export function idTag(kind: string, id: string): string {
  return `<${kind}:${logTag(id)}>`;
}
