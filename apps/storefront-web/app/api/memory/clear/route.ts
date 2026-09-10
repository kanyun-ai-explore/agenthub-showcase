import { clearSubject } from "@/lib/backend/memory-store";
import { errorResponse } from "@/lib/backend/errors";

export async function POST(req: Request) {
  try {
    const { subject_id } = (await req.json()) as { subject_id: string };
    await clearSubject(subject_id);
    return Response.json({});
  } catch (err) {
    return errorResponse(err);
  }
}
