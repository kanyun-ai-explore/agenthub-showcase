import { crossSiteRequest } from "@/lib/backend/guards";
import { canIssueVisitor, mintVisitorId, readVisitor, withVisitorCookie } from "@/lib/backend/visitor-binding";
import { logTag } from "@/lib/log-id";

/**
 * 页面挂载时调一次，拿到访客 cookie `ahv`（`lib/backend/visitor-binding.ts`）。购物车、记忆、偏好和订单的请求，
 * 以及建会话、跨 agent 预热，都等它返回再发（先有 ahv，再发首个回合和预热）。
 *
 * - 没带有效 `ahv`：签一个新身份。带了：续期（同一个 id，exp 往后推）。
 * - `{ "reset": true }`：「换一个身份」。签新身份；旧身份名下的购物车和记忆留在原处，这个浏览器再也认领不到。
 * - 返回 `{ tag }`：访客的日志代号（HMAC，`lib/log-id.ts`），页面拿来显示、给预热句柄做比对。服务端从不把
 *   它当身份认，所以显示出来、截图出去都不是凭据。
 *
 * 跨站请求挡掉：别的站点的页面不该能替访客换身份。
 */
export async function POST(req: Request) {
  if (crossSiteRequest(req)) {
    return Response.json({ error: "cross_origin_not_allowed" }, { status: 403 });
  }
  if (!canIssueVisitor()) {
    return Response.json({ error: "not_configured", detail: "站点没有配置 AGENTHUB_TOKEN，签发不了访客身份。" }, { status: 501 });
  }
  const body = (await req.json().catch(() => ({}))) as { reset?: unknown };
  const id = (body.reset === true ? null : readVisitor(req)) ?? mintVisitorId();
  return withVisitorCookie(
    Response.json({ tag: logTag(id) }, { headers: { "cache-control": "no-store" } }),
    req,
    id,
  );
}
