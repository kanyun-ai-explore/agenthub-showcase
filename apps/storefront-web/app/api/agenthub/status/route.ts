import { isAgentHubConfigured, parseAgentKey } from "@/lib/agenthub/client";

/** The chat surface calls this on load to decide whether to offer live chat or show
 * the "not configured" message — see `components/AgentChat.tsx`. Per-agent, because
 * the merchant workload is configured separately from the shopping one. */
export async function GET(req: Request) {
  const agent = parseAgentKey(new URL(req.url).searchParams.get("agent"));
  return Response.json({ agent, configured: isAgentHubConfigured(agent) });
}
