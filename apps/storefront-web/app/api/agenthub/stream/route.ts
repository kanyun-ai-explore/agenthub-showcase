import { getAgentHubClient, isAgentHubConfigured } from "@/lib/agenthub/client";

/**
 * 一条会话渲染流的 SSE 代理。浏览器不能自己调 `streamEvents`（要 token，token 留在
 * 服务端），所以由这里持有上游生成器再转出去。
 *
 * `id:` 带上 `seq`：EventSource 自己重连时会把它放回 `Last-Event-ID`，成为上游的
 * `lastEventId`。外层网关 60s 掐空闲连接、控制面 300s 主动关连接，两种都靠它续上。
 * 另外禁掉缓冲——中间任何一跳缓冲事件流，逐字输出就变成末尾一次性吐完。
 */

export const dynamic = "force-dynamic";
// SDK 客户端不支持 edge runtime。
export const runtime = "nodejs";

export async function GET(req: Request) {
  if (!isAgentHubConfigured()) {
    return Response.json({ error: "not_configured" }, { status: 501 });
  }
  const url = new URL(req.url);
  const sessionId = url.searchParams.get("sessionId");
  if (!sessionId) {
    return Response.json({ error: "bad_request", detail: "sessionId is required" }, { status: 400 });
  }

  // 自动重连时浏览器带 Last-Event-ID；query 参数是首次连接（刷新后页面自己知道游标）。
  const headerCursor = req.headers.get("last-event-id");
  const queryCursor = url.searchParams.get("lastEventId");
  const raw = Number(headerCursor ?? queryCursor ?? "");
  const lastEventId = Number.isFinite(raw) && raw > 0 ? raw : undefined;

  const { client } = getAgentHubClient();
  const encoder = new TextEncoder();
  const abort = new AbortController();
  req.signal.addEventListener("abort", () => abort.abort());

  const stream = new ReadableStream({
    async start(controller) {
      let open = true;
      const write = (text: string) => {
        if (!open) return;
        try {
          controller.enqueue(encoder.encode(text));
        } catch {
          open = false; // 客户端在检查和写入之间断了
        }
      };

      // 先发一行注释把响应头冲出去，浏览器不用等 agent 第一个 chunk 就能进 onopen。
      write(": open\n\n");
      const heartbeat = setInterval(() => write(": ping\n\n"), 15000);

      try {
        for await (const frame of client.sessions.streamEvents(sessionId, {
          ...(lastEventId ? { lastEventId } : {}),
          signal: abort.signal,
        })) {
          if (!open || abort.signal.aborted) break;
          write(`id: ${frame.seq}\ndata: ${JSON.stringify(frame)}\n\n`);
        }
      } catch (err) {
        // abort 是正常结束（关标签页/关面板）；其他错误报成事件，免得前端无限重连。
        if (!abort.signal.aborted) {
          const detail = err instanceof Error ? err.message : String(err);
          write(`event: stream-error\ndata: ${JSON.stringify({ detail })}\n\n`);
        }
      } finally {
        clearInterval(heartbeat);
        open = false;
        try {
          controller.close();
        } catch {
          // 客户端断开时已经关过了
        }
      }
    },
    cancel() {
      abort.abort();
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}
