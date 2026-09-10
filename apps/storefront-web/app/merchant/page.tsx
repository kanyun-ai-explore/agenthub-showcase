/**
 * 商家视角已并入 showcase（`/showcase/commerce/merchant`）。这个路径仍被仓库文档和早期
 * 验收记录引用，保留为跳转。
 */

import { redirect } from "next/navigation";

export default function MerchantPage() {
  redirect("/showcase/commerce/merchant");
}
