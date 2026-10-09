import { join } from "node:path";

/**
 * Where this embedded backend keeps its mutable state (carts, memory facts,
 * ui-events queue, M3 change ledger). Defaults to `.data/` under the app's own
 * directory (gitignored); `STOREFRONT_DATA_DIR` overrides it for a deployment that
 * wants persistence outside the container's writable layer.
 */
const DATA_DIR = process.env.STOREFRONT_DATA_DIR ?? join(process.cwd(), ".data");

/** The read-only fixture catalog/orders/policies/users, vendored from CMA's own
 * `examples/retail/data/` by `scripts/vendor-cma.sh` (same source as the Python
 * package's copy — see that script for why there are two copies). */
export const FIXTURES_DIR = join(process.cwd(), "data", "retail");

/**
 * 购物车和记忆按访客 id 存。`.v2` 是换过的名：访客身份改由服务端签发（`visitor-binding.ts`）之后不迁移
 * 旧访客，旧文件里那些 id 有的进过日志、有的在页面上显示过；换名让旧数据经任何路由都读不到，
 * 不依赖「发布会清空 .data」这个前提。
 */
export const CARTS_FILE = join(DATA_DIR, "carts.v2.json");
export const MEMORY_FILE = join(DATA_DIR, "memory.v2.json");
export const UI_EVENTS_FILE = join(DATA_DIR, "ui-events.json");
export const CHANGES_FILE = join(DATA_DIR, "changes.json"); // M3 contract b
