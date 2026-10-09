import { loadUsers, preferencesOf } from "@/lib/backend/catalog";
import { errorResponse } from "@/lib/backend/errors";
import { visitorFrom } from "@/lib/backend/request";
import { visitorRequired } from "@/lib/backend/visitor-binding";
import { logTag } from "@/lib/log-id";

export async function POST(req: Request) {
  const userId = visitorFrom(req);
  if (!userId) return visitorRequired();
  try {
    const users = await loadUsers();
    // `user_id` 换成代号：这份偏好会进 agent 的 `get_preferences` 工具结果，再经会话流到页面和门户；
    // 原值是沙箱回调认的身份，不往外带。agent 侧取记忆、分购物车用的是会话自己的 user_id，不读这一项。
    return Response.json({ preferences: { ...preferencesOf(users, userId), user_id: logTag(userId) } });
  } catch (err) {
    return errorResponse(err);
  }
}
