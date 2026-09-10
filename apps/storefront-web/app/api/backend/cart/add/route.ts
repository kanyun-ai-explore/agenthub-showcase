import { addToCart } from "@/lib/backend/cart-store";
import { loadCatalog } from "@/lib/backend/catalog";
import { errorResponse } from "@/lib/backend/errors";
import { userIdFrom } from "@/lib/backend/request";

export async function POST(req: Request) {
  try {
    const { product_id, quantity } = (await req.json()) as { product_id: string; quantity: number };
    const catalog = await loadCatalog();
    const cart = await addToCart(catalog, userIdFrom(req), product_id, quantity);
    return Response.json({ cart });
  } catch (err) {
    return errorResponse(err);
  }
}
