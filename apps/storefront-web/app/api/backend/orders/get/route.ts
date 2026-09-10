import { findOrder, loadOrders } from "@/lib/backend/catalog";
import { errorResponse } from "@/lib/backend/errors";
import { userIdFrom } from "@/lib/backend/request";

export async function POST(req: Request) {
  try {
    const { order_id } = (await req.json()) as { order_id: string };
    const orders = await loadOrders();
    return Response.json({ order: findOrder(orders, userIdFrom(req), order_id) });
  } catch (err) {
    return errorResponse(err);
  }
}
