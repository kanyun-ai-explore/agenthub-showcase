/**
 * course MCP 的 Streamable HTTP 端点。
 *
 * 这是把 course 从 stdio 换成 remote 托管 MCP 的服务端一半——换传输的唯一目的是
 * 拿到工具级人工审批：`always_ask` 只在**经网关的 remote MCP** 上有强制点，stdio 前面
 * 没有网关，平台在发布期就会拒掉这种声明。
 *
 * 链路：沙箱里的 CLI 按 `.mcp.json` 打到平台网关，网关按目标转发并注入凭据（沙箱进程
 * 永远拿不到明文）→ 打到这里。网关是透明代理，客户端发什么它转什么。
 *
 * **无状态实现，不引第三方 MCP SDK**：官方 SDK 的 `StreamableHTTPServerTransport`
 * 面向 Node 的 req/res，塞进 App Router 的 Request/Response 需要造一对假的
 * Node 对象；而这里的工具全是纯读，服务端从不主动推流，用不到会话与 SSE。
 * 因此按 spec 实现无状态子集：POST 收 JSON-RPC 回 `application/json`；GET / DELETE
 * 回 405（spec 明确允许「服务端不提供 SSE 流时 MUST 返回 405」）。网关对 GET/DELETE
 * 当传输层动作放行，不会当成工具调用。
 */

import { COURSE_TOOLS, COURSE_TOOLS_BY_NAME } from "@/lib/course/mcp-tools";

/** 工具读本地数据文件，必须跑在 Node runtime 而不是 Edge。 */
export const runtime = "nodejs";
/** 每次请求现算，不缓存——周报是从 CSV 现算的，缓存会让读数变成快照。 */
export const dynamic = "force-dynamic";

const SERVER_NAME = "course";
const SERVER_VERSION = "1.0.0";
/** 我们实现的是各版本都稳定的那一小块（initialize / tools.list / tools.call），
 *  所以回声客户端请求的版本比钉死一个更不容易撞版本不匹配；客户端没给才用这个。 */
const FALLBACK_PROTOCOL_VERSION = "2025-06-18";

interface JsonRpcRequest {
  jsonrpc?: string;
  id?: string | number | null;
  method?: string;
  params?: Record<string, unknown>;
}

function rpcResult(id: JsonRpcRequest["id"], result: unknown) {
  return { jsonrpc: "2.0", id, result };
}

function rpcError(id: JsonRpcRequest["id"], code: number, message: string) {
  return { jsonrpc: "2.0", id, error: { code, message } };
}

/**
 * 校验 gateway 注入的上游凭据。`COURSE_MCP_TOKEN` 未设时**拒绝所有请求**——
 * fail-closed：漏配环境变量的正确表现是端点不可用，而不是变成一个任何人都能
 * 读到学生数据的开放接口。
 */
function authorized(req: Request): boolean {
  const expected = process.env.COURSE_MCP_TOKEN;
  if (!expected) return false;
  const header = req.headers.get("authorization") ?? "";
  const m = /^Bearer\s+(.+)$/i.exec(header.trim());
  if (!m) return false;
  const given = m[1];
  // 长度先比，避免不等长时 timingSafeEqual 抛错；等长再逐字节比。
  if (given.length !== expected.length) return false;
  let diff = 0;
  for (let i = 0; i < given.length; i += 1) diff |= given.charCodeAt(i) ^ expected.charCodeAt(i);
  return diff === 0;
}

async function handle(body: JsonRpcRequest): Promise<unknown | null> {
  const { id, method, params } = body;
  // 通知（无 id）不回响应体，返回 null 让调用方回 202。
  const isNotification = id === undefined || id === null;

  switch (method) {
    case "initialize":
      return rpcResult(id, {
        protocolVersion:
          (params?.protocolVersion as string | undefined) ?? FALLBACK_PROTOCOL_VERSION,
        capabilities: { tools: {} },
        serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
      });

    case "notifications/initialized":
    case "notifications/cancelled":
      return null;

    case "ping":
      return isNotification ? null : rpcResult(id, {});

    case "tools/list":
      return rpcResult(id, {
        tools: COURSE_TOOLS.map((t) => ({
          name: t.name,
          description: t.description,
          inputSchema: t.inputSchema,
        })),
      });

    case "tools/call": {
      const name = params?.name as string | undefined;
      const tool = name ? COURSE_TOOLS_BY_NAME.get(name) : undefined;
      if (!tool) return rpcError(id, -32602, `unknown tool: ${name ?? "(missing)"}`);
      try {
        const text = await tool.handler((params?.arguments ?? {}) as never);
        return rpcResult(id, { content: [{ type: "text", text }], isError: false });
      } catch (err) {
        // 工具自身失败按 MCP 约定回 isError 的正常结果，不回 JSON-RPC error——
        // 后者是协议层错误，会让客户端认为整个调用不合法而不是这次执行失败。
        return rpcResult(id, {
          content: [{ type: "text", text: `tool ${tool.name} failed: ${String(err)}` }],
          isError: true,
        });
      }
    }

    default:
      return isNotification ? null : rpcError(id, -32601, `method not found: ${method}`);
  }
}

export async function POST(req: Request) {
  if (!authorized(req)) {
    return Response.json({ error: "unauthorized" }, { status: 401 });
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return Response.json(rpcError(null, -32700, "parse error"), { status: 400 });
  }

  // 批量请求：spec 允许数组。逐条处理，过滤掉通知的空响应。
  if (Array.isArray(body)) {
    const out = (await Promise.all(body.map((b) => handle(b as JsonRpcRequest)))).filter(
      (r) => r !== null,
    );
    return out.length === 0 ? new Response(null, { status: 202 }) : Response.json(out);
  }

  const result = await handle(body as JsonRpcRequest);
  return result === null ? new Response(null, { status: 202 }) : Response.json(result);
}

/** 服务端不提供 server→client 的 SSE 流，spec 要求这种情况回 405。 */
export function GET() {
  return new Response("this MCP endpoint does not offer an SSE stream", { status: 405 });
}

/** 无会话可终止（无状态实现），同样回 405。 */
export function DELETE() {
  return new Response("this MCP endpoint is stateless; no session to terminate", { status: 405 });
}
