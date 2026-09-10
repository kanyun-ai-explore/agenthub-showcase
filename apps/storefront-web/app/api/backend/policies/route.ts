import { loadPolicies, searchHelp } from "@/lib/backend/catalog";
import { errorResponse } from "@/lib/backend/errors";

export async function POST(req: Request) {
  try {
    const { query } = (await req.json()) as { query: string };
    const policies = await loadPolicies();
    return Response.json({ policies: searchHelp(policies, query) });
  } catch (err) {
    return errorResponse(err);
  }
}
