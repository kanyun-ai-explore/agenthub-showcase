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

export const CARTS_FILE = join(DATA_DIR, "carts.json");
export const MEMORY_FILE = join(DATA_DIR, "memory.json");
export const UI_EVENTS_FILE = join(DATA_DIR, "ui-events.json");
export const CHANGES_FILE = join(DATA_DIR, "changes.json"); // M3 contract b
