import { mirrorChanges } from "@/lib/backend/changes-store";
import { errorResponse } from "@/lib/backend/errors";
import type { StagedChange } from "@/lib/backend/types-merchant";

/** Called by the merchant stdio server after every stage/apply/discard tool call
 * (see that server's `_mirror_changes`) — not by a browser. */
export async function POST(req: Request) {
  try {
    const { merchant_id, changes } = (await req.json()) as {
      merchant_id: string;
      changes: StagedChange[];
    };
    await mirrorChanges(merchant_id, changes);
    return Response.json({ mirrored: changes.length });
  } catch (err) {
    return errorResponse(err);
  }
}
