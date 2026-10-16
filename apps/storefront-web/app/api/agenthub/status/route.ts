import { isAgentHubConfigured, requestedAgentKey, unknownAgentResponse } from "@/lib/agenthub/client";

/**
 * 某个 agent 在这个部署上配没配：`{ agent, configured }`。只读，不调平台。今天 `apps/` 里没有页面调它。
 *
 * `agent` 参数和建会话、预热路由用同一个判断（`requestedAgentKey`）：没带 → shopping；带了而不在表里
 * （拼错的、已退役的、`constructor` 这类原型链上的名字）→ 400 `unknown_agent`。未知值不能回 shopping 的
 * 状态：问一个已退役的 agent 会得到一个不是它的答案。
 */
export async function GET(req: Request) {
  // searchParams.get 在没带参数时回 null；requestedAgentKey 把 null 当「带了、不认识」，这里先换成 undefined。
  const agent = requestedAgentKey(new URL(req.url).searchParams.get("agent") ?? undefined);
  if (agent === null) return unknownAgentResponse();
  return Response.json({ agent, configured: isAgentHubConfigured(agent) });
}
