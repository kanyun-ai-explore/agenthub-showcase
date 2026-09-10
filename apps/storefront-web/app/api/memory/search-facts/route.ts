import { searchFacts } from "@/lib/backend/memory-store";
import { errorResponse } from "@/lib/backend/errors";

export async function POST(req: Request) {
  try {
    const { subject_id, query } = (await req.json()) as { subject_id: string; query: string };
    return Response.json({ facts: await searchFacts(subject_id, query) });
  } catch (err) {
    return errorResponse(err);
  }
}
