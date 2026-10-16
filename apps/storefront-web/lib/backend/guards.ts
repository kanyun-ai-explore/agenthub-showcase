/**
 * 花平台钱 / 模型钱、签发访客与会话 cookie 的路由共用的挡板。
 *
 * `crossSiteRequest`：这是个演示站，不该成为别人页面上的免费接口，别的站点也不该改得了访客的 cookie。
 * 要挡的是**别的 origin 上的页面拿用户浏览器当跳板**：只放行本站页面（`same-origin`）和地址栏直达（`none`）；
 * 同注册域的别的子域（`same-site`）也是另一个 origin，一样挡。没有 Origin 的请求（curl、服务端脚本、沙箱回调）
 * 不算跨站。用它的路由列全：`git grep -l "crossSiteRequest("`。
 *
 * ⚠️ **不能用 `new URL(req.url).host` 当「本站」**：站点用 `next start -p` 起、
 * 不带 `-H`，route handler 里 `req.url` 的主机名恒为 `localhost`，和请求的 Host 无关（Next 16.2.6
 * 的 `dist/server/lib/router-utils/resolve-routes.js` 取 `opts.hostname || 'localhost'`）。于是浏览器的
 * 同源请求（Origin 是公网域名）比不上，**也 403**——语音回合从浏览器一发就被挡（`cross_origin_not_allowed`），
 * 一期的 `/api/tts` 更早就落在同一条沟里（页面一直静默退到浏览器本机语音：无 Origin 的 curl 走不到这一支，
 * 所以没暴露）。
 *
 * 判据顺序：
 *   1. `Sec-Fetch-Site`（现代浏览器每个请求都发）：`same-origin` / `none` 放行，其余
 *      （`same-site`、`cross-site`）拒。这一支不依赖任何主机名头。
 *   2. 没有这个头（curl、老浏览器）时，把 `Origin` 的 **host** 跟 `host` 头比。
 *      **不用 `X-Forwarded-Host`**：网关不剥离时它是客户端可控的——伪造得了的字段不能
 *      进鉴权判据（证明不了就只留 Sec-Fetch-Site + host）。带了它结果不变。
 *   3. 有 Origin 却连 `host` 都没有：fail-closed——宁可不放行，也不当别人的免费接口。
 *
 * 威胁模型是**浏览器里的第三方页面**：`Origin`、`Sec-Fetch-Site`、`Host` 这三个头
 * 都是浏览器自己写的，页面伪造不了；能随手改这些头的客户端（脚本）本来也不需要
 * 借道我们这个站。
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
