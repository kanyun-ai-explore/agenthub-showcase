import { getAgentHubClient, isAgentHubConfigured } from "@/lib/agenthub/client";
import { renderTurn } from "@/lib/agenthub/turn-parts";
import { errorResponse } from "@/lib/backend/errors";

/**
 * Sends one turn, waits for it to settle, and returns everything the page renders:
 * the assistant's own text, the `present_*` cards, and the tool trace.
 *
 * The cards come out of THIS turn (see `lib/agenthub/turn-parts.ts`): under
 * `CMA_UI_DELIVERY=result_text` the enriched envelope is the `present_*` tool's own
 * result, so no inbound call from the sandbox is involved. The separate
 * `/api/agent/ui-events` SSE stream stays wired for mode B (`backend_post`), which
 * only works where the sandbox can reach this deployment; the page merges both.
 */
export async function POST(req: Request) {
  if (!isAgentHubConfigured()) {
    return Response.json({ error: "not_configured" }, { status: 501 });
  }
  try {
    const { agentHubSessionId, text } = (await req.json()) as {
      agentHubSessionId: string;
      text: string;
    };
    const { client } = getAgentHubClient();
    const turn = await client.sessions.sendTurn(agentHubSessionId, { text });
    if (turn.kind === "revival_in_progress") {
      return Response.json({ status: "revival_in_progress" });
    }
    const { turn: settled } = await client.sessions.waitForTurn(agentHubSessionId, turn.turnId);
    const rendered = renderTurn(settled.assistant?.parts);
    return Response.json({
      status: settled.status,
      turnId: turn.turnId,
      replyText: rendered.replyText,
      cards: rendered.cards,
      toolCalls: rendered.toolCalls,
      reasoningCount: rendered.reasoning.length,
    });
  } catch (err) {
    return errorResponse(err);
  }
}
