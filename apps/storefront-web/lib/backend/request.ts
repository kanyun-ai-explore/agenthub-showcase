/** Shared request helpers for `app/api/backend/**` routes. */

import { resolveVisitor } from "./visitor-binding";

/**
 * 这个请求的访客（`lib/backend/visitor-binding.ts`）。浏览器以 `ahv` cookie 为准，自己报的
 * `X-CMA-User` 不看；沙箱 stdio server 的 `HttpStorefrontBackend` 带不了访客 cookie，从自己的 env 取身份
 * 放在 `X-CMA-User` 上（D-R3：不经过模型、不是工具参数），那一类只认高熵形状和 eval 身份。
 * null = 认不出，路由回 `visitorRequired()`。之前缺 header 时落到共用的 `"demo-user"`，现在不落了。
 */
export function visitorFrom(req: Request): string | null {
  return resolveVisitor(req, req.headers.get("x-cma-user"));
}
