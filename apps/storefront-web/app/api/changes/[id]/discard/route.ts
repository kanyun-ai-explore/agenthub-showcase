import { operatorDiscard } from "@/lib/backend/changes-store";
import { errorResponse } from "@/lib/backend/errors";

/** The operator page's discard button — hides the row here only; see
 * `lib/backend/changes-store.ts`'s module docstring for the documented asymmetry
 * with approve. `id` is the store's own `mirror_key`, not the bare `change_id` —
 * same reasoning as the approve route. */
export async function POST(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const updated = await operatorDiscard(id);
    if (!updated) return Response.json({ error: "not_found" }, { status: 404 });
    return Response.json({ change: updated });
  } catch (err) {
    return errorResponse(err);
  }
}
