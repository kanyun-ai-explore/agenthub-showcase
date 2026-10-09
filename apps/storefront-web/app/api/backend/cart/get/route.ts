import { getCart } from "@/lib/backend/cart-store";
import { errorResponse } from "@/lib/backend/errors";
import { visitorFrom } from "@/lib/backend/request";
import { visitorRequired } from "@/lib/backend/visitor-binding";

export async function POST(req: Request) {
  const userId = visitorFrom(req);
  if (!userId) return visitorRequired();
  try {
    const cart = await getCart(userId);
    return Response.json({ cart });
  } catch (err) {
    return errorResponse(err);
  }
}
