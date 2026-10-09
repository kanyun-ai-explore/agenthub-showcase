/**
 * `agent/ui-events` (reproduction plan §6 contract d, `CMA_UI_DELIVERY=backend_post`
 * mode). `POST` is the stdio server's write side
 * (`storefront_stdio_server.__main__._post_ui_event`); `GET` is the frontend's read
 * side, either polling (`?sessionId=&since=`, the default) or SSE
 * (`?sessionId=&stream=1`) — see `lib/backend/ui-events.ts` for the in-memory queue
 * both share.
 *
 * 归属：`GET` 要求 `sessionId` 是这个浏览器建的 AgentHub 会话
 * （`lib/agenthub/session-binding.ts`），否则 404。队列的键是 stdio server 的
 * `CMA_CHAT_SESSION_ID`（两个 agent 都没设，缺省 `"local-session"`，所有访客共用一条），不是平台的
 * session id，所以按现在的配置读口一律 404——两个 agent 都是 `CMA_UI_DELIVERY: result_text`，
 * 页面也没有调用方，读口关掉是有意的。`POST` 是沙箱的写口，带不了访客 cookie，不验。
 */

import { ownsSession, sessionNotFound } from "@/lib/agenthub/session-binding";
import { errorResponse } from "@/lib/backend/errors";
import { eventsSince, publishUiEvent, subscribe } from "@/lib/backend/ui-events";

export async function POST(req: Request) {
  try {
    const sessionId = req.headers.get("x-cma-chat-session-id");
    if (!sessionId) {
      return Response.json({ error: "bad_request", detail: "X-CMA-Chat-Session-Id is required" }, { status: 400 });
    }
    const { component, payload } = (await req.json()) as { component: string; payload: unknown };
    const event = publishUiEvent(sessionId, component, payload);
    return Response.json({ accepted: true, seq: event.seq });
  } catch (err) {
    return errorResponse(err);
  }
}

export async function GET(req: Request) {
  const url = new URL(req.url);
  const sessionId = url.searchParams.get("sessionId");
  if (!sessionId) {
    return Response.json({ error: "bad_request", detail: "sessionId query param is required" }, { status: 400 });
  }
  // 归属：不是这个浏览器建的会话一律 404，在调平台之前（lib/agenthub/session-binding.ts）。
  if (!ownsSession(req, sessionId)) return sessionNotFound();
  const since = Number(url.searchParams.get("since") ?? "0") || 0;

  if (url.searchParams.get("stream") !== "1") {
    const events = eventsSince(sessionId, since);
    const cursor = events.length > 0 ? events[events.length - 1].seq : since;
    return Response.json({ events, cursor });
  }

  const stream = new ReadableStream({
    start(controller) {
      const encoder = new TextEncoder();
      const send = (data: unknown) => controller.enqueue(encoder.encode(`data: ${JSON.stringify(data)}\n\n`));
      for (const event of eventsSince(sessionId, since)) send(event);
      const unsubscribe = subscribe(sessionId, send);
      const heartbeat = setInterval(() => controller.enqueue(encoder.encode(": keep-alive\n\n")), 15000);
      req.signal.addEventListener("abort", () => {
        clearInterval(heartbeat);
        unsubscribe();
        controller.close();
      });
    },
  });
  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    },
  });
}
