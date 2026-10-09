import { PilotPlatformApiError } from "@kanyun-ai-infra/agenthub";
import { getAgentHubClient, isAgentHubConfigured } from "@/lib/agenthub/client";
import { ownsSession, sessionNotFound } from "@/lib/agenthub/session-binding";
import { settledTurnBody, waitForTurnWithin } from "@/lib/agenthub/turn-wait";
import { errorResponse } from "@/lib/backend/errors";

/**
 * Sends one turn and waits for it to settle — but only up to `TURN_REQUEST_MAX_MS`
 * (`lib/agenthub/turn-wait.ts`), counted from when this request arrived. A turn that settles
 * in time comes back whole: the assistant's own text, the `present_*` cards, and the tool trace.
 * One that doesn't comes back as `{ status: "pending", turnId }`, and the page asks
 * `/api/agenthub/turn-result` for the rest. A request held open for the whole turn is cut by
 * the reverse proxy in front of the site at 60 s, and a shopping first turn runs ~54 s.
 *
 * The cards come out of THIS turn (see `lib/agenthub/turn-parts.ts`): under
 * `CMA_UI_DELIVERY=result_text` the enriched envelope is the `present_*` tool's own
 * result, so no inbound call from the sandbox is involved. The separate
 * `/api/agent/ui-events` SSE stream stays wired for mode B (`backend_post`), which
 * only works where the sandbox can reach this deployment; the page merges both.
 */
export async function POST(req: Request) {
  const startedAt = Date.now();
  if (!isAgentHubConfigured()) {
    return Response.json({ error: "not_configured" }, { status: 501 });
  }
  try {
    const { agentHubSessionId, text } = (await req.json()) as {
      agentHubSessionId: string;
      text: string;
    };
    // 归属：不是这个浏览器建的会话一律 404，在调平台之前（lib/agenthub/session-binding.ts）。
    if (!ownsSession(req, agentHubSessionId)) return sessionNotFound();
    const { client } = getAgentHubClient();
    const turn = await client.sessions.sendTurn(agentHubSessionId, { text });
    if (turn.kind === "revival_in_progress") {
      return Response.json({ status: "revival_in_progress" });
    }
    const settled = await waitForTurnWithin(client, agentHubSessionId, turn.turnId, {
      startedAt,
      signal: req.signal,
    }).catch((err: unknown) => {
      // 回合是平台刚接受的，只是回合行还没投影出来：SDK 的可见宽限 = 剩下的预算，派发慢时只剩一两秒。
      // 不当失败，回 pending 交给 turn-result 去等。
      if (err instanceof PilotPlatformApiError && err.code === "TURN_NOT_FOUND") return null;
      throw err;
    });
    if (!settled) return Response.json({ status: "pending", turnId: turn.turnId });
    return Response.json(settledTurnBody(settled, turn.turnId));
  } catch (err) {
    return errorResponse(err);
  }
}
