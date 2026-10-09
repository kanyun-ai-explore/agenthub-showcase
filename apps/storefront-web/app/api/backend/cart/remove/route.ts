import { removeFromCart } from "@/lib/backend/cart-store";
import { errorResponse } from "@/lib/backend/errors";
import { visitorFrom } from "@/lib/backend/request";
import { visitorRequired } from "@/lib/backend/visitor-binding";

export async function POST(req: Request) {
  const userId = visitorFrom(req);
  if (!userId) return visitorRequired();
  try {
    const { product_id } = (await req.json()) as { product_id: string };
    const cart = await removeFromCart(userId, product_id);
    return Response.json({ cart });
  } catch (err) {
    return errorResponse(err);
  }
}
