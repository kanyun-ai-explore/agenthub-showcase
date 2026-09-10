import { upsertFacts } from "@/lib/backend/memory-store";
import { errorResponse } from "@/lib/backend/errors";
import type { MemoryFact } from "@/lib/backend/types";

export async function POST(req: Request) {
  try {
    const { subject_id, facts } = (await req.json()) as { subject_id: string; facts: MemoryFact[] };
    await upsertFacts(subject_id, facts);
    return Response.json({});
  } catch (err) {
    return errorResponse(err);
  }
}
