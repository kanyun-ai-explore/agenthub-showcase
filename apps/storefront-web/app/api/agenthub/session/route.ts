import {
  agentIdFor,
  envNameFor,
  getAgentHubClient,
  isAgentHubConfigured,
  parseAgentKey,
} from "@/lib/agenthub/client";
import { errorResponse } from "@/lib/backend/errors";
import { moveCart } from "@/lib/backend/cart-store";
import { moveSubject } from "@/lib/backend/memory-store";

/**
 * 给某个 file-defined agent 建会话。
 *
 * 冷启时响应在记录建好时就返回，那时沙箱还在启动，调用方轮询
 * `GET /api/agenthub/session/<id>` 等 ready 再发轮次；命中预热池时响应里
 * 就是 `status: "ready"`，不用轮询。
 */
/**
 * 购物侧走平台的终端用户身份（EUID）而不是 `configValues.CMA_END_USER_ID`：带 configValues
 * 的会话永远进不了预热池，而 EUID 正是为这个场景做的——池在暖机时就铸好一个
 * `<prefix>_<nanoid>` 身份，沙箱内以 `PILOT_END_USER_ID` 读到（保留前缀，调用方伪造不了），
 * stdio server 优先取它。页面拿到 `userId` 后把它当访客 id 用在 `X-CMA-User` 上，购物车、
 * 记忆、偏好三处按同一个 id 隔离。
 *
 * 领用响应本身不带身份，要 `sessions.get` 一次读 `session.user`。没拿到身份（池空、
 * 池未配 `mintUser`、退到了冷启、或 `sessions.get` 本身失败）时，这个无身份的会话不能用
 * ——它在沙箱里会落到 agent.yaml 的 `CMA_END_USER_ID: eval-user`，所有访客共用一辆购物车。
 * 于是释放它，再用页面自己的访客 id 冷启一次（`user.id` 带入 = 明确不吃池）。代价是池
 * miss 时多一次冷启（被释放的那个），换来的是永远不会串号。
 *
 * 采纳 EUID 时把访客在会话建立**之前**以本地 id 攒下的购物车和记忆搬到 EUID 名下
 * （`moveCart` / `moveSubject`），否则沙箱一就绪、页面身份翻转，徽标从 2 掉回 0。页面
 * 随后把 EUID 记成本地 id，下次来访再搬一次——身份就这样一段段接着走。
 */
async function createShoppingSession(
  client: ReturnType<typeof getAgentHubClient>["client"],
  projectId: string,
  agentId: string,
  stage: ReturnType<typeof getAgentHubClient>["env"]["stage"],
  visitorId: string | undefined,
): Promise<{ agentHubSessionId: string; status: string; userId: string }> {
  const pooled = await client.sessions.create({ projectId, agentId, stage, preferPrewarmed: true });
  if (pooled.status === "ready") {
    let userId: string | undefined;
    try {
      userId = (await client.sessions.get(pooled.sessionId)).session?.user?.id ?? undefined;
    } catch (err) {
      console.warn(`[agenthub/session] sessions.get(${pooled.sessionId}) failed; treating as no EUID`, err);
    }
    if (userId) {
      if (visitorId && visitorId !== userId) await adoptIdentity(visitorId, userId);
      return { agentHubSessionId: pooled.sessionId, status: pooled.status, userId };
    }
  }
  // No platform-minted identity on this session — let it go and cold-start with our own.
  console.warn(
    `[agenthub/session] shopping session ${pooled.sessionId} (${pooled.status}) carries no EUID; releasing and cold-starting with the visitor id`,
  );
  void client.sessions.releaseSandbox(pooled.sessionId).catch((err: unknown) => {
    console.warn(`[agenthub/session] release of ${pooled.sessionId} failed`, err);
  });
  const fallbackId = visitorId ?? "demo-user";
  const cold = await client.sessions.create({ projectId, agentId, stage, user: { id: fallbackId } });
  return { agentHubSessionId: cold.sessionId, status: cold.status, userId: fallbackId };
}

/** Carry the visitor's pre-session cart and memory over to the id the session runs under. */
async function adoptIdentity(fromId: string, toId: string): Promise<void> {
  try {
    const [cart, facts] = await Promise.all([moveCart(fromId, toId), moveSubject(fromId, toId)]);
    if (cart.items.length > 0 || facts > 0) {
      console.info(`[agenthub/session] identity ${fromId} → ${toId}: ${cart.items.length} cart lines, ${facts} memory facts`);
    }
  } catch (err) {
    // The session is still usable under the new id; only the hand-off failed.
    console.warn(`[agenthub/session] identity hand-off ${fromId} → ${toId} failed`, err);
  }
}

export async function POST(req: Request) {
  const body = (await req.json().catch(() => ({}))) as {
    chatSessionId?: string;
    endUserId?: string;
    agent?: unknown;
  };
  const agent = parseAgentKey(body.agent);

  if (!isAgentHubConfigured(agent)) {
    return Response.json(
      {
        error: "not_configured",
        detail: `agent「${agent}」未接入：请设置环境变量 ${envNameFor(agent) ?? "对应的 agent id"}。`,
      },
      { status: 501 },
    );
  }
  try {
    const { client, env } = getAgentHubClient();
    const agentId = agentIdFor(env, agent);
    if (!agentId) throw new Error(`agent「${agent}」没有配置 workload id`);

    if (agent === "shopping") {
      return Response.json(await createShoppingSession(client, env.projectId, agentId, env.stage, body.endUserId));
    }

    // D-R3 身份：商家侧的 merchant id 必须与审批页读的那个一致，否则改动镜像到没人看的
    // key 下，队列恒为空且不报错。这两个常量固定在 agent.yaml 的 env
    // （CMA_MERCHANT_ID / CMA_OPERATOR，与 lib/showcase/merchant.ts 的
    // SHOWCASE_MERCHANT_ID / SHOWCASE_OPERATOR 一致），不再随会话注入，会话因此能命中
    // 预热池。`merchantId` 请求字段不再生效；CMA_CHAT_SESSION_ID 由 stdio server
    // 缺省为 "local-session"。
    //
    // ⚠️ 只有商家侧真的读这两个值——它的 stdio MCP server 用 `os.environ` 取
    // （merchant_stdio_server）。**教育侧四个 agent 一个都不读**（agent.yaml 零引用、
    // 运行时目录零文件，实查过）；购物侧改走上面的 EUID 链。
    const session = await client.sessions.create({
      projectId: env.projectId,
      agentId,
      stage: env.stage,
      preferPrewarmed: true,
    });
    // `status` is "ready" when the session came from the prewarming pool: the page
    // then skips the readiness poll entirely.
    return Response.json({ agentHubSessionId: session.sessionId, status: session.status });
  } catch (err) {
    return errorResponse(err);
  }
}
