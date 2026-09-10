import { deleteFact } from "@/lib/backend/memory-store";
import { errorResponse } from "@/lib/backend/errors";

export async function POST(req: Request) {
  try {
    const { subject_id, key } = (await req.json()) as { subject_id: string; key: string };
    return Response.json({ deleted: await deleteFact(subject_id, key) });
  } catch (err) {
    return errorResponse(err);
  }
}
