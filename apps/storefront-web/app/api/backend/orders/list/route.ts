import { loadOrders, ordersFor } from "@/lib/backend/catalog";
import { errorResponse } from "@/lib/backend/errors";
import { visitorFrom } from "@/lib/backend/request";
import { visitorRequired } from "@/lib/backend/visitor-binding";

export async function POST(req: Request) {
  const userId = visitorFrom(req);
  if (!userId) return visitorRequired();
  try {
    const { limit } = (await req.json()) as { limit?: number };
    const orders = await loadOrders();
    return Response.json({ orders: ordersFor(orders, userId, limit ?? 5) });
  } catch (err) {
    return errorResponse(err);
  }
}
