import { errorResponse } from "@/lib/backend/errors";

/** Optional method (`StorefrontBackend.get_account_context`); this demo has no
 * account model beyond `UserPreferences`, so it returns `None` — CMA's own
 * default. */
export async function POST() {
  try {
    return Response.json({ account: null });
  } catch (err) {
    return errorResponse(err);
  }
}
