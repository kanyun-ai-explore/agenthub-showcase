import { findProduct, loadCatalog } from "@/lib/backend/catalog";
import { errorResponse } from "@/lib/backend/errors";

export async function POST(req: Request) {
  try {
    const { product_id } = (await req.json()) as { product_id: string };
    const catalog = await loadCatalog();
    const product = findProduct(catalog, product_id);
    return Response.json({ product: product ?? null });
  } catch (err) {
    return errorResponse(err);
  }
}
