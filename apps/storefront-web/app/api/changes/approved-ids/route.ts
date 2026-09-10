import { approvedChangeIds } from "@/lib/backend/changes-store";
import { errorResponse } from "@/lib/backend/errors";

/** Called by the merchant stdio server immediately before dispatching
 * `apply_change` (see `_fetch_approved_ids`) — the one call `check_apply_change`'s
 * approval gate actually depends on. */
export async function GET(req: Request) {
  try {
    const merchantId = new URL(req.url).searchParams.get("merchantId") ?? "acme-retail";
    return Response.json({ approved_change_ids: await approvedChangeIds(merchantId) });
  } catch (err) {
    return errorResponse(err);
  }
}
