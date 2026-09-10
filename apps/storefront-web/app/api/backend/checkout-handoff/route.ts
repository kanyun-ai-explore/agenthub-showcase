import { errorResponse } from "@/lib/backend/errors";

/** Optional method (`StorefrontBackend.checkout_handoff`); this demo has no
 * external checkout provider, so it returns none — matching CMA's own default
 * ("the host's card leads to its own checkout"). */
export async function POST() {
  try {
    return Response.json({ handoffs: [] });
  } catch (err) {
    return errorResponse(err);
  }
}
