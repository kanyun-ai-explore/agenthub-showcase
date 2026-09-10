import { loadOrders, ordersFor } from "@/lib/backend/catalog";
import { errorResponse } from "@/lib/backend/errors";
import { userIdFrom } from "@/lib/backend/request";

export async function POST(req: Request) {
  try {
    const { limit } = (await req.json()) as { limit?: number };
    const orders = await loadOrders();
    return Response.json({ orders: ordersFor(orders, userIdFrom(req), limit ?? 5) });
  } catch (err) {
    return errorResponse(err);
  }
}
