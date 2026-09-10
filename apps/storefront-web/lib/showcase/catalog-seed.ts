/**
 * First-paint catalog for the shopper phone.
 *
 * Read on the server so the shelf is in the initial HTML: the sandbox takes tens of
 * seconds to start, and a storefront that renders nothing until the agent exists
 * would make the platform look slow for a reason that has nothing to do with it.
 */

import { loadCatalog, toSummary } from "@/lib/backend/catalog";
import type { CatalogSeed } from "@/components/showcase/CaseStage";

export async function catalogSeed(limit = 60): Promise<CatalogSeed> {
  const catalog = await loadCatalog();
  const all = [...catalog.listings.values()];

  const counts: Record<string, number> = {};
  for (const product of all) {
    if (product.category) counts[product.category] = (counts[product.category] ?? 0) + 1;
  }

  const ordered = [...all].sort(
    (a, b) =>
      Number(b.in_stock ?? true) - Number(a.in_stock ?? true) ||
      (b.rating ?? 0) - (a.rating ?? 0) ||
      (b.review_count ?? 0) - (a.review_count ?? 0),
  );

  return {
    products: ordered.slice(0, limit).map(toSummary),
    categories: Object.keys(counts).sort(),
    counts,
    total: all.length,
  };
}
