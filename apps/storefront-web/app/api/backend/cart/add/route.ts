import { addToCart } from "@/lib/backend/cart-store";
import { loadCatalog } from "@/lib/backend/catalog";
import { errorResponse } from "@/lib/backend/errors";
import { visitorFrom } from "@/lib/backend/request";
import { visitorRequired } from "@/lib/backend/visitor-binding";

export async function POST(req: Request) {
  const userId = visitorFrom(req);
  if (!userId) return visitorRequired();
  try {
    const { product_id, quantity } = (await req.json()) as { product_id: string; quantity: number };
    const catalog = await loadCatalog();
    const cart = await addToCart(catalog, userId, product_id, quantity);
    return Response.json({ cart });
  } catch (err) {
    return errorResponse(err);
  }
}
