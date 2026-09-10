import { getCart } from "@/lib/backend/cart-store";
import { errorResponse } from "@/lib/backend/errors";
import { userIdFrom } from "@/lib/backend/request";

export async function POST(req: Request) {
  try {
    const cart = await getCart(userIdFrom(req));
    return Response.json({ cart });
  } catch (err) {
    return errorResponse(err);
  }
}
