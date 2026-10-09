import {
  agentIdFor,
  envNameFor,
  getAgentHubClient,
  isAgentHubConfigured,
  parseAgentKey,
} from "@/lib/agenthub/client";
import { withSessionBinding } from "@/lib/agenthub/session-binding";
import { errorResponse } from "@/lib/backend/errors";
import { crossSiteRequest } from "@/lib/backend/guards";
import { moveCart } from "@/lib/backend/cart-store";
import { moveSubject } from "@/lib/backend/memory-store";
import { isVisitorId, mintVisitorId, readVisitor, withVisitorCookie } from "@/lib/backend/visitor-binding";
import { idTag, logTag } from "@/lib/log-id";

/**
 * 给某个 file-defined agent 建会话。
 *
 * 冷启时响应在记录建好时就返回，那时沙箱还在启动，调用方轮询
 * `GET /api/agenthub/session/<id>` 等 ready 再发轮次；命中预热池时响应里
 * 就是 `status: "ready"`，不用轮询。
 *
 * 响应带上这个会话的归属 cookie（`lib/agenthub/session-binding.ts`）：池里的会话是平台建的，
 * 在这里被领走、id 第一次交给浏览器，领走它的浏览器就是主人；之后收这个 id 的路由都先验它。
 */
/**
 * 购物侧走平台的终端用户身份（EUID）而不是 `configValues.CMA_END_USER_ID`：带 configValues
 * 的会话永远进不了预热池，而 EUID 正是为这个场景做的——池在暖机时就铸好一个
 * `<prefix>_<nanoid>` 身份，沙箱内以 `PILOT_END_USER_ID` 读到（保留前缀，调用方伪造不了），
 * stdio server 优先取它，沙箱回调站点时把它放在 `X-CMA-User` 上；购物车、记忆、偏好三处按同一个 id 隔离。
 *
 * 访客身份只认访客 cookie `ahv`（`lib/backend/visitor-binding.ts`）：请求 body 里的 `endUserId`
 * 一律不看——之前它既是冷启的 `user.id`，又是下面「搬家」的源头，谁报别人的 id 就能把别人的购物车和记忆
 * 搬进自己的会话。采纳 EUID 后响应把 `ahv` 改成 EUID，页面之后的请求跟着它走；响应不回 id，只回代号 `visitorTag`。
 *
 * 领用响应本身不带身份，要 `sessions.get` 一次读 `session.user`。没拿到身份（池空、
 * 池未配 `mintUser`、退到了冷启、或 `sessions.get` 本身失败）时，这个无身份的会话不能用
 * ——它在沙箱里会落到 agent.yaml 的 `CMA_END_USER_ID: eval-user`，所有访客共用一辆购物车。
 * 于是释放它，再用 cookie 里的访客 id 冷启一次（`user.id` 带入 = 明确不吃池）。代价是池
 * miss 时多一次冷启（被释放的那个），换来的是永远不会串号。
 *
 * 采纳 EUID 时把访客在会话建立**之前**以 cookie 身份攒下的购物车和记忆搬到 EUID 名下
 * （`moveCart` / `moveSubject`），否则沙箱一就绪、页面身份翻转，徽标从 2 掉回 0。cookie
 * 随后改成 EUID，下次来访再搬一次——身份就这样一段段接着走。
 */
async function createShoppingSession(
  client: ReturnType<typeof getAgentHubClient>["client"],
  projectId: string,
  agentId: string,
  stage: ReturnType<typeof getAgentHubClient>["env"]["stage"],
  visitorId: string,
): Promise<{ agentHubSessionId: string; status: string; userId: string }> {
  const pooled = await client.sessions.create({ projectId, agentId, stage, preferPrewarmed: true });
  if (pooled.status === "ready") {
    let userId: string | undefined;
    try {
      userId = (await client.sessions.get(pooled.sessionId)).session?.user?.id ?? undefined;
    } catch (err) {
      console.warn(`[agenthub/session] sessions.get(${pooled.sessionId}) failed; treating as no EUID`, err);
    }
    if (userId && isVisitorId(userId)) {
      if (visitorId !== userId) await adoptIdentity(visitorId, userId);
      return { agentHubSessionId: pooled.sessionId, status: pooled.status, userId };
    }
    // 形状不符的 EUID（平台改了铸法）：cookie 发不出去、沙箱回调会被拒，采纳了浏览器和沙箱就各认一个身份。
    // 按「没有 EUID」处理，下面冷启。只记代号。
    if (userId) console.warn(`[agenthub/session] EUID ${idTag("euid", userId)} does not match the visitor id shape; treating as no EUID`);
  }
  // No platform-minted identity on this session — let it go and cold-start with our own.
  console.warn(
    `[agenthub/session] shopping session ${pooled.sessionId} (${pooled.status}) carries no EUID; releasing and cold-starting as ${idTag("visitor", visitorId)}`,
  );
  void client.sessions.releaseSandbox(pooled.sessionId).catch((err: unknown) => {
    console.warn(`[agenthub/session] release of ${pooled.sessionId} failed`, err);
  });
  const cold = await client.sessions.create({ projectId, agentId, stage, user: { id: visitorId } });
  return { agentHubSessionId: cold.sessionId, status: cold.status, userId: visitorId };
}

/** Carry the visitor's pre-session cart and memory over to the id the session runs under. */
async function adoptIdentity(fromId: string, toId: string): Promise<void> {
  try {
    const [cart, facts] = await Promise.all([moveCart(fromId, toId), moveSubject(fromId, toId)]);
    if (cart.items.length > 0 || facts > 0) {
      console.info(
        `[agenthub/session] identity ${idTag("visitor", fromId)} → ${idTag("visitor", toId)}: ${cart.items.length} cart lines, ${facts} memory facts`,
      );
    }
  } catch (err) {
    // The session is still usable under the new id; only the hand-off failed.
    console.warn(`[agenthub/session] identity hand-off ${idTag("visitor", fromId)} → ${idTag("visitor", toId)} failed`, err);
  }
}

export async function POST(req: Request) {
  // 跨站挡板：购物侧在这里签发 / 改写访客 cookie `ahv`。第三方页面用表单 POST 导航过来时
  // 浏览器不带原来的 Strict cookie，站点会签一个新身份，顶层导航的响应写得进 Strict cookie——访客原来的身份就被
  // 覆盖了（Chromium 148 实测）。和 `/api/visitor` 同一个判法；顺带也挡住跨站页面替访客领走或新建平台会话。
  if (crossSiteRequest(req)) {
    return Response.json({ error: "cross_origin_not_allowed" }, { status: 403 });
  }
  const body = (await req.json().catch(() => ({}))) as {
    chatSessionId?: string;
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
      // 没带有效 `ahv`（部署前打开着、没调过 /api/visitor 的页面）就在这里签一个，随响应发下去。
      const visitorId = readVisitor(req) ?? mintVisitorId();
      const created = await createShoppingSession(client, env.projectId, agentId, env.stage, visitorId);
      // 只绑最后交出去的那个：池会话没有 EUID 被释放时，绑的是冷启的那个。
      const res = Response.json({
        agentHubSessionId: created.agentHubSessionId,
        status: created.status,
        visitorTag: logTag(created.userId),
      });
      return withVisitorCookie(withSessionBinding(res, req, created.agentHubSessionId), req, created.userId);
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
    return withSessionBinding(
      Response.json({ agentHubSessionId: session.sessionId, status: session.status }),
      req,
      session.sessionId,
    );
  } catch (err) {
    return errorResponse(err);
  }
}
