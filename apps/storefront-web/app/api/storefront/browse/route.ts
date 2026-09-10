import { loadCatalog, toSummary } from "@/lib/backend/catalog";
import { errorResponse } from "@/lib/backend/errors";

/**
 * Browse the catalog for the storefront page.
 *
 * Deliberately NOT `/api/backend/search-products`: that route is contract (a), the
 * agent's own tool surface, and its `rankProducts` returns `[]` for an empty query
 * (it is a keyword search, not a lister). A storefront needs to show its shelves
 * before anyone types anything, so this is a page-only endpoint over the same
 * catalog — adding a "list everything" mode to the agent's search tool would change
 * a contract the agent depends on, to serve a need the agent does not have.
 */
export async function GET(req: Request) {
  try {
    const url = new URL(req.url);
    const category = url.searchParams.get("category");
    const limit = Math.min(Number(url.searchParams.get("limit") ?? 60) || 60, 200);

    const catalog = await loadCatalog();
    const all = [...catalog.listings.values()];

    const categories = [...new Set(all.map((p) => p.category).filter(Boolean))].sort() as string[];

    const filtered = category && category !== "all" ? all.filter((p) => p.category === category) : all;
    // Stable, useful default order: in-stock first, then rating, then review volume.
    // Not "relevance" — there is no query here to be relevant to.
    const ordered = [...filtered].sort(
      (a, b) =>
        Number(b.in_stock ?? true) - Number(a.in_stock ?? true) ||
        (b.rating ?? 0) - (a.rating ?? 0) ||
        (b.review_count ?? 0) - (a.review_count ?? 0),
    );

    return Response.json({
      categories,
      total: filtered.length,
      products: ordered.slice(0, limit).map(toSummary),
    });
  } catch (err) {
    return errorResponse(err);
  }
}
