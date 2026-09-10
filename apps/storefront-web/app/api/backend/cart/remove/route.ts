import { removeFromCart } from "@/lib/backend/cart-store";
import { errorResponse } from "@/lib/backend/errors";
import { userIdFrom } from "@/lib/backend/request";

export async function POST(req: Request) {
  try {
    const { product_id } = (await req.json()) as { product_id: string };
    const cart = await removeFromCart(userIdFrom(req), product_id);
    return Response.json({ cart });
  } catch (err) {
    return errorResponse(err);
  }
}
