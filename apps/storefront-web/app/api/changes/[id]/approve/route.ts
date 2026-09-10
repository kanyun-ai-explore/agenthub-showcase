import { setApproved } from "@/lib/backend/changes-store";
import { errorResponse } from "@/lib/backend/errors";

/** The operator page's approve button. This is the ONLY thing that can make
 * `apply_change` succeed under `require_host_approval` — see
 * `lib/backend/changes-store.ts`'s module docstring. `id` is the store's own
 * `mirror_key` (URL-encoded by the caller), NOT the bare `change_id` — see that
 * module's docstring for why bare change_id collides across ChangeLedger resets. */
export async function POST(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const updated = await setApproved(id, true);
    if (!updated) return Response.json({ error: "not_found" }, { status: 404 });
    return Response.json({ change: updated });
  } catch (err) {
    return errorResponse(err);
  }
}
