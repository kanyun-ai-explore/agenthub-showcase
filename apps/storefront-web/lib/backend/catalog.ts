/**
 * Catalog loading and keyword search — a TypeScript reduction of CMA's own
 * per-vertical `demo_common/storefront_fixtures.py` (`load_catalog`, `keyword_score`,
 * `rank_products`, `find_product`), reimplemented rather than ported line-for-line
 * because this app is Node/TS and that module is Python calling into
 * `shopping_agent`'s pydantic types.
 *
 * Deliberately NOT ported (documented simplification, not an oversight — none of
 * these affect what tool result the model sees, only extra storefront-web-only
 * flourishes CMA's own richer demo detail panel adds): per-product delivery-promise
 * stamping, low-stock stamping, 90-day price-intelligence series, review-aspect
 * chips, and in-flight-order re-dating. Ported: family/variant catalog assembly,
 * weighted keyword scoring with a small synonym table, the relevance-cutoff +
 * soft-filter + sort ranking pipeline, and case-insensitive id lookup.
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { Order, Policy, Product, ProductDetails, SearchFilters, UserPreferences } from "./types";
import { FIXTURES_DIR } from "./paths";

export interface CatalogIndex {
  storeName: string;
  listings: Map<string, ProductDetails>;
  variants: Map<string, ProductDetails>;
}

const VARIANT_INHERITS = [
  "title",
  "brand",
  "price",
  "currency",
  "rating",
  "review_count",
  "image_url",
  "category",
  "short_description",
  "long_description",
  "specs",
] as const;

function withDefaults(raw: Record<string, unknown>): ProductDetails {
  return {
    product_id: String(raw.product_id),
    title: String(raw.title ?? ""),
    brand: (raw.brand as string | undefined) ?? null,
    price: Number(raw.price ?? 0),
    // 固定数据由 scripts/localize-fixtures.py 显式写入 CNY；这里只是兜底。
    currency: (raw.currency as string | undefined) ?? "CNY",
    rating: (raw.rating as number | undefined) ?? null,
    review_count: (raw.review_count as number | undefined) ?? null,
    image_url: (raw.image_url as string | undefined) ?? null,
    category: (raw.category as string | undefined) ?? null,
    labels: (raw.labels as string[] | undefined) ?? [],
    attributes: (raw.attributes as Record<string, string> | undefined) ?? {},
    in_stock: raw.in_stock === undefined ? true : Boolean(raw.in_stock),
    short_description: (raw.short_description as string | undefined) ?? null,
    options: (raw.options as Record<string, string[]> | undefined) ?? {},
    option_values: (raw.option_values as Record<string, string> | undefined) ?? {},
    variant_of: (raw.variant_of as string | undefined) ?? null,
    long_description: (raw.long_description as string | undefined) ?? null,
    specs: (raw.specs as Record<string, string> | undefined) ?? {},
    review_highlights: (raw.review_highlights as string[] | undefined) ?? [],
    variants: [],
  };
}

function optionsOf(variants: ProductDetails[]): Record<string, string[]> {
  const options: Record<string, string[]> = {};
  for (const variant of variants) {
    for (const [option, value] of Object.entries(variant.option_values)) {
      const values = (options[option] ??= []);
      if (!values.includes(value)) values.push(value);
    }
  }
  return options;
}

let cached: CatalogIndex | null = null;
let cachedUsers: Map<string, UserPreferences> | null = null;
let cachedOrders: { userId: string; order: Order }[] | null = null;
let cachedPolicies: Policy[] | null = null;

export async function loadCatalog(): Promise<CatalogIndex> {
  if (cached) return cached;
  const raw = JSON.parse(await readFile(join(FIXTURES_DIR, "catalog.json"), "utf-8")) as {
    store_name?: string;
    products: Record<string, unknown>[];
  };
  const listings = new Map<string, ProductDetails>();
  const variants = new Map<string, ProductDetails>();
  for (const entry of raw.products) {
    const { variants: rawVariants, ...familyRaw } = entry as {
      variants?: Record<string, unknown>[];
    } & Record<string, unknown>;
    const family = withDefaults(familyRaw);
    const familyVariants: ProductDetails[] = [];
    for (const compact of rawVariants ?? []) {
      const filled: Record<string, unknown> = {};
      for (const key of VARIANT_INHERITS) {
        if (key in familyRaw) filled[key] = (familyRaw as Record<string, unknown>)[key];
      }
      Object.assign(filled, compact);
      filled.variant_of = family.product_id;
      filled.attributes = {
        ...family.attributes,
        ...((compact.attributes as Record<string, string> | undefined) ?? {}),
      };
      const variant = withDefaults(filled);
      variants.set(variant.product_id, variant);
      familyVariants.push(variant);
    }
    if (familyVariants.length > 0) {
      if (Object.keys(family.options).length === 0) family.options = optionsOf(familyVariants);
      family.in_stock = familyVariants.some((v) => v.in_stock);
      family.variants = familyVariants;
    }
    listings.set(family.product_id, family);
  }
  cached = { storeName: raw.store_name ?? "the store", listings, variants };
  return cached;
}

/** A listing or a variant by id — exact match first, then a case-insensitive scan,
 * mirroring `demo_common.storefront_fixtures.find_product`/`find_by_id`. */
export function findProduct(catalog: CatalogIndex, productId: string): ProductDetails | null {
  if (catalog.listings.has(productId)) return catalog.listings.get(productId)!;
  if (catalog.variants.has(productId)) return catalog.variants.get(productId)!;
  const lowered = productId.toLowerCase();
  for (const index of [catalog.listings, catalog.variants]) {
    for (const [key, value] of index) {
      if (key.toLowerCase() === lowered) return value;
    }
  }
  return null;
}

export function listingOf(catalog: CatalogIndex, productId: string): ProductDetails | null {
  const record = findProduct(catalog, productId);
  if (record?.variant_of) return catalog.listings.get(record.variant_of) ?? record;
  return record;
}

export function toSummary(product: ProductDetails): Product {
  const { long_description, specs, review_highlights, variants, ...summary } = product;
  return summary;
}

const WORD = /[a-z0-9]+/g;
function tokens(text: string): string[] {
  return (text.toLowerCase().match(WORD) ?? []) as string[];
}
function stem(token: string): string {
  return token.length > 3 && token.endsWith("s") ? token.slice(0, -1) : token;
}

const SEARCH_WEIGHTS: Record<string, number> = {
  title: 3.0,
  brand: 2.0,
  category: 2.0,
  attributes: 1.5,
  description: 1.0,
};

const SYNONYMS: Record<string, string[]> = {
  luggage: ["spinner", "carry-on", "suitcase"],
  suitcase: ["spinner", "carry-on", "luggage"],
  headphones: ["headphone", "earphones"],
  computer: ["laptop", "monitor"],
  workout: ["fitness", "exercise"],
  exercise: ["fitness", "workout"],
  couch: ["sofa"],
  present: ["gift"],
  camping: ["camp", "tent", "outdoor"],
  cook: ["cookware", "kitchen"],
  coffee: ["espresso"],
  sleep: ["sleeping"],
  pack: ["backpack"],
  hike: ["hiking"],
};

function optionText(product: Product): string {
  return Object.entries(product.options)
    .map(([option, values]) => `${option} ${values.join(" ")}`)
    .join(" ");
}

function searchableFields(product: ProductDetails): Record<string, string> {
  return {
    title: product.title,
    brand: product.brand ?? "",
    category: product.category ?? "",
    attributes: `${Object.entries(product.attributes)
      .map(([k, v]) => `${k} ${v}`)
      .join(" ")} ${optionText(product)}`,
    description: `${product.short_description ?? ""} ${product.long_description ?? ""}`,
  };
}

function keywordScore(product: ProductDetails, queryTokens: string[]): number {
  const fields = searchableFields(product);
  const stemmedFields: Record<string, Set<string>> = {};
  for (const [name, text] of Object.entries(fields)) {
    stemmedFields[name] = new Set(tokens(text).map(stem));
  }
  let score = 0;
  for (const token of queryTokens) {
    const stemmed = stem(token);
    const candidates = [stemmed, ...(SYNONYMS[stemmed] ?? []).map(stem)];
    let best = 0;
    for (const [name, weight] of Object.entries(SEARCH_WEIGHTS)) {
      if (candidates.some((c) => stemmedFields[name].has(c))) best = Math.max(best, weight);
    }
    score += best;
  }
  return score;
}

function withinPriceAndRating(product: ProductDetails, filters: SearchFilters): boolean {
  if (filters.min_price != null && product.price < filters.min_price) return false;
  if (filters.max_price != null && product.price > filters.max_price) return false;
  return filters.min_rating == null || (product.rating ?? 0) >= filters.min_rating;
}

function softFilter(product: ProductDetails, filters: SearchFilters): boolean {
  if (filters.category && !(product.category ?? "").toLowerCase().includes(filters.category.toLowerCase()))
    return false;
  if (!filters.attributes || Object.keys(filters.attributes).length === 0) return true;
  const haystack =
    Object.entries(product.attributes)
      .map(([k, v]) => `${k}=${v}`.toLowerCase())
      .join(" ") +
    ` ${product.title.toLowerCase()} ${optionText(product).toLowerCase()}`;
  return Object.values(filters.attributes).every((value) => haystack.includes(String(value).toLowerCase()));
}

export function rankProducts(
  catalog: CatalogIndex,
  query: string,
  filters: SearchFilters | null,
  limit: number,
): ProductDetails[] {
  const queryTokens = tokens(query);
  if (queryTokens.length === 0) return [];
  let scored = [...catalog.listings.values()]
    .filter((p) => !filters || withinPriceAndRating(p, filters))
    .map((p) => ({ points: keywordScore(p, queryTokens), product: p }))
    .filter((s) => s.points > 0);
  if (scored.length > 0) {
    const best = Math.max(...scored.map((s) => s.points));
    scored = scored.filter((s) => s.points >= best / 2);
  }
  if (filters) {
    const narrowed = scored.filter((s) => softFilter(s.product, filters));
    if (narrowed.length > 0) scored = narrowed;
  }
  const sort = filters?.sort ?? "relevance";
  if (sort === "price_asc") scored.sort((a, b) => a.product.price - b.product.price);
  else if (sort === "price_desc") scored.sort((a, b) => b.product.price - a.product.price);
  else if (sort === "rating") scored.sort((a, b) => (b.product.rating ?? 0) - (a.product.rating ?? 0));
  else
    scored.sort((a, b) => b.points - a.points || (b.product.rating ?? 0) - (a.product.rating ?? 0));
  return scored.slice(0, limit).map((s) => s.product);
}

export async function loadUsers(): Promise<Map<string, UserPreferences>> {
  if (cachedUsers) return cachedUsers;
  const raw = JSON.parse(await readFile(join(FIXTURES_DIR, "users.json"), "utf-8")) as {
    users: UserPreferences[];
  };
  cachedUsers = new Map(raw.users.map((u) => [u.user_id, u]));
  return cachedUsers;
}

/** 演示人设的模板：固定数据里按 user_id 索引的那一份。 */
const PERSONA_TEMPLATE = "demo-user";

/**
 * 未知访客继承演示人设，但保留自己的 user_id。
 *
 * 每个浏览器一个访客 id 之后，没有一个访客能在 users.json 里找到自己，
 * 全都会退化成没有偏好、没有历史的 Guest —— 而「记住你的偏好」正是这个
 * 页面要演示的能力。所以偏好和订单这类只读人设走模板，购物车和记忆这类
 * 可变状态按访客自己的 id 分开。
 */
export function preferencesOf(users: Map<string, UserPreferences>, userId: string): UserPreferences {
  const own = users.get(userId);
  if (own) return own;
  const template = users.get(PERSONA_TEMPLATE);
  if (!template) return { user_id: userId, display_name: "Guest", preferences: {} };
  return { ...template, user_id: userId };
}

export async function loadOrders(): Promise<{ userId: string; order: Order }[]> {
  if (cachedOrders) return cachedOrders;
  const raw = JSON.parse(await readFile(join(FIXTURES_DIR, "orders.json"), "utf-8")) as {
    orders: (Order & { user_id: string })[];
  };
  cachedOrders = raw.orders.map(({ user_id, ...order }) => ({ userId: user_id, order: order as Order }));
  return cachedOrders;
}

/** 订单历史同样走人设模板 —— 理由见 `preferencesOf`。 */
export function ordersFor(orders: { userId: string; order: Order }[], userId: string, limit: number): Order[] {
  const own = orders.filter((o) => o.userId === userId);
  const rows = own.length > 0 ? own : orders.filter((o) => o.userId === PERSONA_TEMPLATE);
  return rows
    .map((o) => o.order)
    .sort((a, b) => (a.placed_at < b.placed_at ? 1 : -1))
    .slice(0, limit);
}

/** 单单查询也走模板，否则 `get_order_status` 会对 `ordersFor` 刚列出来的单号说不存在。 */
export function findOrder(
  orders: { userId: string; order: Order }[],
  userId: string,
  orderId: string,
): Order | null {
  const wanted = orderId.toLowerCase();
  const match = (owner: string) =>
    orders.find((o) => o.userId === owner && o.order.order_id.toLowerCase() === wanted)?.order ?? null;
  return match(userId) ?? match(PERSONA_TEMPLATE);
}

const HELP_STOPWORDS = new Set([
  "a", "an", "and", "any", "are", "as", "at", "be", "by", "can", "do", "does", "for",
  "from", "get", "how", "i", "if", "in", "is", "it", "its", "me", "my", "of", "on",
  "or", "so", "that", "the", "there", "this", "to", "up", "we", "what", "when",
  "which", "will", "with", "you", "your",
]);

function helpTerms(text: string): Set<string> {
  return new Set(tokens(text).filter((t) => !HELP_STOPWORDS.has(t)).map(stem));
}

export async function loadPolicies(): Promise<Policy[]> {
  if (cachedPolicies) return cachedPolicies;
  const raw = JSON.parse(await readFile(join(FIXTURES_DIR, "policies.json"), "utf-8")) as {
    policies: Policy[];
  };
  cachedPolicies = raw.policies;
  return cachedPolicies;
}

export function searchHelp(policies: Policy[], query: string, limit = 3): Policy[] {
  const queryTerms = helpTerms(query);
  if (queryTerms.size === 0) return [];
  const scored: { points: number; policy: Policy }[] = [];
  for (const policy of policies) {
    const heading = helpTerms(`${policy.title} ${policy.category ?? ""}`);
    const body = helpTerms(policy.content);
    const headingHits = [...queryTerms].filter((t) => heading.has(t)).length;
    const bodyHits = [...queryTerms].filter((t) => body.has(t)).length;
    const points = 2 * headingHits + bodyHits;
    if (points > 0) scored.push({ points, policy });
  }
  scored.sort((a, b) => b.points - a.points);
  return scored.slice(0, limit).map((s) => s.policy);
}
