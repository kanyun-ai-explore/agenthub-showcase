import { getAgentHubClient, isAgentHubConfigured } from "@/lib/agenthub/client";
import { errorResponse } from "@/lib/backend/errors";

/**
 * 会话就绪轮询。建会话在记录建好时就返回，那时沙箱还没起来。
 *
 * ⚠️ `sessions.get()` 返回的是信封，状态在 `result.session.status`，不是
 * `result.status`。读外层得到 undefined，而 `Response.json({status: undefined})`
 * 序列化成 `{}` 且 HTTP 200——轮询看着健康，页面永远等不到状态，输入框一直禁用。
 * 当时的接口测试只验了「调用成功」，没验「字段存在」，所以没抓到。
 */
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  if (!isAgentHubConfigured()) {
    return Response.json({ error: "not_configured" }, { status: 501 });
  }
  try {
    const { id } = await params;
    const { client } = getAgentHubClient();
    const result = await client.sessions.get(id);
    const status = result.session?.status ?? null;
    return Response.json({
      status,
      // Surfaced so the page can say WHY it is still waiting rather than just
      // spinning: a session waiting on Agent Recovery is not the same as one whose
      // sandbox is still booting.
      pendingRevival: result.pendingRevival ?? null,
      failureReason: result.session?.failureReason ?? null,
    });
  } catch (err) {
    return errorResponse(err);
  }
}
