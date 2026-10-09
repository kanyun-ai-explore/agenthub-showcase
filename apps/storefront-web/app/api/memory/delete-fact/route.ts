import { deleteFact } from "@/lib/backend/memory-store";
import { errorResponse } from "@/lib/backend/errors";
import { resolveVisitor, visitorRequired } from "@/lib/backend/visitor-binding";

export async function POST(req: Request) {
  try {
    const { subject_id, key } = (await req.json()) as { subject_id?: unknown; key: string };
    // 浏览器以 `ahv` cookie 为准，body 里的 subject_id 不看；沙箱的 `HttpMemoryStore` 带不了 cookie，
    // 只认高熵形状（`lib/backend/visitor-binding.ts`）。
    const subject = resolveVisitor(req, subject_id);
    if (!subject) return visitorRequired();
    return Response.json({ deleted: await deleteFact(subject, key) });
  } catch (err) {
    return errorResponse(err);
  }
}
