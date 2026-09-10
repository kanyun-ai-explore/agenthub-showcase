import { pendingChanges } from "@/lib/backend/changes-store";
import { errorResponse } from "@/lib/backend/errors";

/** The operator page's read side. `merchantId` query param scopes the list — a
 * showcase-scale simplification standing in for the operator's own authenticated
 * merchant scope. */
export async function GET(req: Request) {
  try {
    const merchantId = new URL(req.url).searchParams.get("merchantId") ?? "acme-retail";
    return Response.json({ changes: await pendingChanges(merchantId) });
  } catch (err) {
    return errorResponse(err);
  }
}
