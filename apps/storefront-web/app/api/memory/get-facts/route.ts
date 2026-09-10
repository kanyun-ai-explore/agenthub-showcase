import { getFacts } from "@/lib/backend/memory-store";
import { errorResponse } from "@/lib/backend/errors";

export async function POST(req: Request) {
  try {
    const { subject_id } = (await req.json()) as { subject_id: string };
    return Response.json({ facts: await getFacts(subject_id) });
  } catch (err) {
    return errorResponse(err);
  }
}
