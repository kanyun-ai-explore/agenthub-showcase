import { errorResponse } from "@/lib/backend/errors";

/** Optional method (`StorefrontBackend.get_disclosure`); `present_disclosure` is
 * off by default (`CMA_ENABLE_DISCLOSURES=false`, see the agent's `agent.yaml`), so
 * this demo backend has no fixture disclosures authored and returns `None` for
 * every id — CMA's own default. Wire it up (author `Disclosure` rows per product
 * id) if a deployment turns the tool on. */
export async function POST() {
  try {
    return Response.json({ disclosure: null });
  } catch (err) {
    return errorResponse(err);
  }
}
