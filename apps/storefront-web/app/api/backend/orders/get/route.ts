import { findOrder, loadOrders } from "@/lib/backend/catalog";
import { errorResponse } from "@/lib/backend/errors";
import { visitorFrom } from "@/lib/backend/request";
import { visitorRequired } from "@/lib/backend/visitor-binding";

export async function POST(req: Request) {
  const userId = visitorFrom(req);
  if (!userId) return visitorRequired();
  try {
    const { order_id } = (await req.json()) as { order_id: string };
    const orders = await loadOrders();
    return Response.json({ order: findOrder(orders, userId, order_id) });
  } catch (err) {
    return errorResponse(err);
  }
}
