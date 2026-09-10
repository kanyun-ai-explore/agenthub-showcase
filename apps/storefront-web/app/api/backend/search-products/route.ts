import { loadCatalog, rankProducts, toSummary } from "@/lib/backend/catalog";
import { errorResponse } from "@/lib/backend/errors";
import type { SearchFilters } from "@/lib/backend/types";

export async function POST(req: Request) {
  try {
    const body = (await req.json()) as { query: string; filters?: SearchFilters | null; limit?: number };
    const catalog = await loadCatalog();
    const ranked = rankProducts(catalog, body.query, body.filters ?? null, body.limit ?? 8);
    return Response.json({ products: ranked.map(toSummary) });
  } catch (err) {
    return errorResponse(err);
  }
}
