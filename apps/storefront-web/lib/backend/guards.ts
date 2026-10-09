/**
 * 花平台钱/花模型钱的路由共用的挡板。
 *
 * `crossSiteRequest`：这是个演示站，不该成为别人页面上的免费接口。要挡的是
 * **别的站点里的页面拿用户浏览器当跳板**（同站页面、curl、服务端脚本都照常放行，
 * 所以没有 Origin 的请求一律不算跨站）。`/api/course/audio`（单元 3 的读音，取代
 * 已删掉的 `/api/tts`）、`/api/agenthub/voice-turn`、`/api/agenthub/turn-audio` 三处共用这一份实现。
 *
 * ⚠️ **不能用 `new URL(req.url).host` 当「本站」**（线上实际出过事故）：
 * 部署里 ingress 会把请求 URL 的 host 改写成 pod 内部地址，于是**同源请求也 403**
 * ——语音回合从浏览器一发就被挡（`cross_origin_not_allowed`），一期的 `/api/tts`
 * 更早就落在同一条沟里（页面一直静默退到浏览器本机语音：当时的验收读数都是无
 * Origin 的 curl，没暴露）。
 *
 * 判据顺序：
 *   1. `Sec-Fetch-Site`（现代浏览器每个请求都发）：`same-origin` / `none` 放行，
 *      `cross-site` 拒。这一支不依赖任何主机名头，是生产上真正生效的那条。
 *   2. 没有这个头（curl、老浏览器）时，把 `Origin` 的 **host** 跟 `host` 头比。
 *      **不用 `X-Forwarded-Host`**：网关不剥离时它是客户端可控的——伪造得了的字段不能
 *      进鉴权判据（证明不了就只留 Sec-Fetch-Site + host）。
 *   3. 有 Origin 却连 `host` 都没有：fail-closed——宁可不放行，也不当别人的免费接口。
 *
 * 威胁模型是**浏览器里的第三方页面**：`Origin`、`Sec-Fetch-Site`、`Host` 这三个头
 * 都是浏览器自己写的，页面伪造不了；能随手改这些头的客户端（脚本）本来也不需要
 * 借道我们这个站。变异自测见 `scripts/cross-site-guard/check.mjs`（三刀 + 阴阳对照）。
 */
export function crossSiteRequest(req: Request): boolean {
  const fetchSite = req.headers.get("sec-fetch-site");
  if (fetchSite !== null) {
    // `none` = 用户直接敲地址 / 书签打开，不是别的页面在打我们，照放。
    return fetchSite !== "same-origin" && fetchSite !== "none";
  }

  const origin = req.headers.get("origin");
  if (!origin) return false;

  const host = req.headers.get("host")?.trim();
  if (!host) return true;

  try {
    return new URL(origin).host !== host;
  } catch {
    return true;
  }
}
