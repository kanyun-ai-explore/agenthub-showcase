import { loadUsers, preferencesOf } from "@/lib/backend/catalog";
import { errorResponse } from "@/lib/backend/errors";
import { userIdFrom } from "@/lib/backend/request";

export async function POST(req: Request) {
  try {
    const users = await loadUsers();
    return Response.json({ preferences: preferencesOf(users, userIdFrom(req)) });
  } catch (err) {
    return errorResponse(err);
  }
}
