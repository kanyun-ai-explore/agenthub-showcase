"use client";

/**
 * 消费者侧的手机 App。先是个能用的店，其次才是 agent 演示：沙箱要 20 秒才起来，
 * 在那之前货架、分类、详情、购物车都得能点。agent 写的购物车就是货架写的那一个。
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import type { Product } from "@/lib/backend/types";
import type { Order, UserPreferences } from "@/lib/backend/types";
import type { Conversation } from "@/components/agent/useAgentConversation";
import { ProductArt, CategoryGlyph, categoryColors } from "./ProductArt";
import { IconBack, IconCart, IconChevron, IconGrid, IconHome, IconSearch, IconSparkle, IconStar, IconUser } from "./icons";
import { AgentSheet } from "./AgentSheet";
import { useCart } from "./useCart";
import { useMemory } from "./useMemory";
import { visitorHeaders } from "@/lib/showcase/visitor";
import { money, priceParts, reviewLabel } from "@/components/generative/format";

const CATEGORY_LABELS: Record<string, string> = {
  "beauty-personal-care": "美妆个护",
  grocery: "食品生鲜",
  "kids-room": "母婴童品",
  "home-kitchen": "家居厨房",
  "office-electronics": "办公数码",
  "outdoor-camping": "户外露营",
  fitness: "运动健身",
  "toys-games": "玩具游戏",
  "pet-supplies": "宠物用品",
  travel: "旅行出行",
  "furniture-bedroom": "卧室家具",
};

const label = (category: string) => CATEGORY_LABELS[category] ?? category.replace(/-/g, " ");

const MEMORY_CATEGORY: Record<string, string> = {
  preference: "偏好",
  constraint: "约束",
  context: "背景",
};

type Tab = "home" | "category" | "cart" | "me";

function Price({ value, currency }: { value: number; currency?: string }) {
  const [symbol, digits] = priceParts(value, currency ?? "CNY");
  return (
    <span className="m-price">
      <small>{symbol}</small>
      {digits}
    </span>
  );
}

function StatusBar({ dark }: { dark?: boolean }) {
  return (
    <div className="m-status" data-dark={dark ? "true" : "false"}>
      <span>9:41</span>
      <span className="m-status-right">
        <svg viewBox="0 0 18 12" width="17" height="11" fill="currentColor" opacity="0.9">
          <rect x="0" y="8" width="3" height="4" rx="1" />
          <rect x="4.6" y="5.6" width="3" height="6.4" rx="1" />
          <rect x="9.2" y="3" width="3" height="9" rx="1" />
          <rect x="13.8" y="0.4" width="3" height="11.6" rx="1" />
        </svg>
        <span style={{ fontSize: 10.5, fontWeight: 700, letterSpacing: 0 }}>5G</span>
        <span className="m-battery" />
      </span>
    </div>
  );
}

// ── Tabs ─────────────────────────────────────────────────────────────────────

function ProductTile({ product, onOpen }: { product: Product; onOpen: (id: string) => void }) {
  const reviews = reviewLabel(product.review_count);
  return (
    <button type="button" className="m-pc" onClick={() => onOpen(product.product_id)}>
      <ProductArt
        productId={product.product_id}
        category={product.category}
        badge={product.in_stock === false ? "缺货" : product.labels?.includes("bestseller") ? "热卖" : null}
      />
      <div className="m-pc-body">
        <div className="m-pc-title">{product.title}</div>
        <div className="m-pc-tags">
          {(product.labels ?? []).slice(0, 2).map((tag) => (
            <span className="m-tag" key={tag}>
              {tag}
            </span>
          ))}
          {product.brand ? (
            <span className="m-tag" data-tone="gray">
              {product.brand}
            </span>
          ) : null}
        </div>
        <div className="m-pc-foot">
          <Price value={product.price} currency={product.currency} />
          <span className="m-sold">{reviews ?? ""}</span>
        </div>
      </div>
    </button>
  );
}

function HomeTab({
  products,
  categories,
  total,
  loading,
  category,
  onCategory,
  onOpen,
  query,
  onQuery,
}: {
  products: Product[];
  categories: string[];
  total: number;
  loading: boolean;
  category: string;
  onCategory: (c: string) => void;
  onOpen: (id: string) => void;
  query: string;
  onQuery: (q: string) => void;
}) {
  const top = useMemo(
    () => [...products].sort((a, b) => (b.rating ?? 0) - (a.rating ?? 0)).slice(0, 8),
    [products],
  );

  return (
    <>
      <div className="m-head">
        <div className="m-head-top">
          <div className="m-logo">
            ACME <small>SHOP</small>
          </div>
        </div>
        <div className="m-search">
          <IconSearch />
          <input value={query} onChange={(e) => onQuery(e.target.value)} placeholder="搜索商品、品牌" />
          <span className="m-search-go">搜索</span>
        </div>
      </div>

      <div className="m-body">
        <div className="m-banner">
          <h3>不知道买什么？让 AI 导购来配</h3>
          <p>说清楚预算和用途，它会检索全店商品、给出方案，并把商品卡直接摆在对话里。</p>
          <span className="m-banner-cta">
            点底部中间那颗按钮 <span style={{ opacity: 0.6 }}>→</span>
          </span>
        </div>

        <div className="m-cats">
          {categories.slice(0, 10).map((c) => {
            const [from, to] = categoryColors(c);
            return (
              <button
                type="button"
                className="m-cat"
                key={c}
                data-active={category === c}
                onClick={() => onCategory(category === c ? "all" : c)}
              >
                <span
                  className="m-cat-ico"
                  style={{ background: `linear-gradient(140deg, ${from}, ${to})`, color: categoryColors(c)[2] }}
                >
                  <span style={{ width: 22, height: 22, display: "grid", placeItems: "center" }}>
                    <CategoryGlyph category={c} />
                  </span>
                </span>
                {label(c)}
              </button>
            );
          })}
        </div>

        <div className="m-flash">
          <div className="m-flash-head">
            <b className="m-flame">口碑榜</b>
            <span className="m-clock">
              评分最高的 {top.length} 件
            </span>
          </div>
          <div className="m-flash-row">
            {top.map((product) => (
              <button type="button" className="m-flash-item" key={product.product_id} onClick={() => onOpen(product.product_id)}>
                <ProductArt productId={product.product_id} category={product.category} />
                <div className="m-flash-price">
                  {money(product.price, product.currency)}
                </div>
                <div style={{ fontSize: 10, color: "#8a8f99", display: "flex", alignItems: "center", gap: 3 }}>
                  <IconStar />
                  {product.rating?.toFixed(1)}
                </div>
              </button>
            ))}
          </div>
        </div>

        <div className="m-sec">
          <h3>{category === "all" ? "为你推荐" : label(category)}</h3>
          <span className="m-sec-more">
            {loading ? "加载中…" : `${products.length} / ${total} 件`}
          </span>
        </div>

        <div className="m-feed">
          {products.map((product) => (
            <ProductTile key={product.product_id} product={product} onOpen={onOpen} />
          ))}
        </div>
        {!loading && products.length === 0 ? (
          <div className="m-empty">
            <div className="m-empty-ico">🔍</div>
            没有匹配的商品
          </div>
        ) : null}
      </div>
    </>
  );
}

function CategoryTab({
  categories,
  counts,
  onPick,
}: {
  categories: string[];
  counts: Record<string, number>;
  onPick: (c: string) => void;
}) {
  return (
    <>
      <div className="m-head" style={{ paddingBottom: 14 }}>
        <div className="m-head-top">
          <div className="m-logo">全部分类</div>
        </div>
      </div>
      <div className="m-body">
        <div className="m-panel" style={{ marginTop: 6 }}>
          {categories.map((c) => {
            const [from, to, ink] = categoryColors(c);
            return (
              <button type="button" className="m-row" key={c} onClick={() => onPick(c)}>
                <span
                  className="m-cat-ico"
                  style={{ width: 38, height: 38, background: `linear-gradient(140deg, ${from}, ${to})`, color: ink, flex: "none" }}
                >
                  <span style={{ width: 20, height: 20, display: "grid", placeItems: "center" }}>
                    <CategoryGlyph category={c} />
                  </span>
                </span>
                <div className="m-row-main">
                  <div className="m-row-title">{label(c)}</div>
                  <div className="m-row-sub">{counts[c] ?? 0} 件在售</div>
                </div>
                <IconChevron />
              </button>
            );
          })}
        </div>
      </div>
    </>
  );
}

function CartTab({
  cart,
  busy,
  onUpdate,
  onRemove,
  onToast,
  onShop,
}: {
  cart: ReturnType<typeof useCart>;
  busy: boolean;
  onUpdate: (id: string, qty: number) => void;
  onRemove: (id: string) => void;
  onToast: (text: string) => void;
  onShop: () => void;
}) {
  const items = cart.cart?.items ?? [];
  return (
    <>
      <div className="m-head" style={{ paddingBottom: 14 }}>
        <div className="m-head-top">
          <div className="m-logo">购物车</div>
        </div>
      </div>
      <div className="m-body">
        {items.length === 0 ? (
          <div className="m-empty">
            <div className="m-empty-ico">🛒</div>
            购物车还是空的
            <div style={{ marginTop: 12 }}>
              <button type="button" className="m-btn" data-variant="ghost" onClick={onShop}>
                去逛逛
              </button>
            </div>
          </div>
        ) : (
          <div className="m-panel" style={{ marginTop: 6 }}>
            {items.map((item) => (
              <div className="m-row" key={item.product_id}>
                <div className="m-thumb">
                  <ProductArt productId={item.product_id} category={null} />
                </div>
                <div className="m-row-main">
                  <div className="m-row-title" style={{ whiteSpace: "normal" }}>
                    {item.title}
                  </div>
                  <Price value={item.price} />
                </div>
                <div style={{ display: "grid", gap: 6, justifyItems: "end" }}>
                  <div className="m-qty">
                    <button type="button" disabled={busy} onClick={() => onUpdate(item.product_id, item.quantity - 1)}>
                      −
                    </button>
                    <span>{item.quantity}</span>
                    <button type="button" disabled={busy} onClick={() => onUpdate(item.product_id, item.quantity + 1)}>
                      +
                    </button>
                  </div>
                  <button
                    type="button"
                    style={{ fontSize: 11, color: "#a9aeb6" }}
                    onClick={() => onRemove(item.product_id)}
                  >
                    删除
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
      {items.length > 0 ? (
        <div className="m-bar">
          <div className="m-bar-total">
            合计（{cart.count} 件）
            <b>{money(cart.subtotal)}</b>
          </div>
          <button type="button" className="m-btn" onClick={() => onToast("演示环境：结算流程未接入支付")}>
            去结算
          </button>
        </div>
      ) : null}
    </>
  );
}

function MeTab({
  preferences,
  orders,
  memory,
  visitorId,
  onForget,
}: {
  preferences: UserPreferences | null;
  orders: Order[];
  memory: ReturnType<typeof useMemory>;
  visitorId: string | null;
  onForget: () => void;
}) {
  return (
    <>
      <div className="m-head" style={{ paddingBottom: 34 }}>
        <div className="m-head-top">
          <div className="m-logo">我的</div>
        </div>
      </div>
      <div className="m-body" style={{ marginTop: -20 }}>
        <div className="m-panel" style={{ padding: "16px 14px" }}>
          <div style={{ display: "flex", gap: 12, alignItems: "center" }}>
            <div
              style={{
                width: 48,
                height: 48,
                borderRadius: 999,
                background: "linear-gradient(140deg,#ffd6c2,#ffb59a)",
                display: "grid",
                placeItems: "center",
                fontSize: 19,
                fontWeight: 700,
                color: "#a8542f",
              }}
            >
              {(preferences?.display_name ?? "?").slice(0, 1)}
            </div>
            <div>
              <div style={{ fontSize: 16, fontWeight: 680 }}>{preferences?.display_name ?? "访客"}</div>
              <div style={{ fontSize: 11.5, color: "#8a8f99", marginTop: 2 }}>
                {preferences?.loyalty_tier ?? "—"}
                {preferences?.default_location ? ` · ${preferences.default_location}` : ""}
              </div>
            </div>
          </div>
        </div>

        <div className="m-sec">
          <h3>历史订单</h3>
          <span className="m-sec-more">{orders.length} 单</span>
        </div>
        <div className="m-panel">
          {orders.length === 0 ? (
            <div className="m-empty" style={{ padding: "34px 20px" }}>
              暂无订单
            </div>
          ) : (
            orders.map((order) => (
              <div className="m-row" key={order.order_id}>
                <div className="m-row-main">
                  <div className="m-row-title">
                    {order.items?.[0]?.title ?? order.order_id}
                    {order.items && order.items.length > 1 ? ` 等 ${order.items.length} 件` : ""}
                  </div>
                  <div className="m-row-sub">
                    {order.order_id} · {order.status}
                    {order.estimated_delivery ? ` · 预计 ${order.estimated_delivery.slice(0, 10)}` : ""}
                  </div>
                </div>
                <div style={{ fontSize: 13, fontWeight: 650 }}>{money(order.total, order.currency)}</div>
              </div>
            ))
          )}
        </div>

        <div className="m-sec">
          <h3>Agent 记住的我</h3>
          <span className="m-sec-more">{memory.facts.length} 条</span>
        </div>
        <div className="m-panel" style={{ padding: "4px 14px 12px" }}>
          {memory.facts.length === 0 ? (
            <div style={{ fontSize: 12, color: "#8a8f99", padding: "12px 0", lineHeight: 1.7 }}>
              还没有记住任何事。去跟导购聊聊你的预算、尺码、忌口或者家里几口人，
              它判断值得长期记的会自己存下来，然后出现在这里。
            </div>
          ) : (
            memory.facts.map((fact) => (
              <div key={fact.key} style={{ padding: "9px 0", borderBottom: "1px solid var(--m-line)" }}>
                <div style={{ display: "flex", gap: 6, alignItems: "center", marginBottom: 3 }}>
                  <span className="m-tag" data-tone="gray">
                    {MEMORY_CATEGORY[fact.category] ?? fact.category}
                  </span>
                  <span style={{ fontSize: 10.5, color: "#a9aeb6", fontFamily: "var(--mono)" }}>
                    {fact.key}
                  </span>
                </div>
                <div style={{ fontSize: 12.5, lineHeight: 1.55 }}>{fact.value}</div>
              </div>
            ))
          )}
          {memory.facts.length > 0 ? (
            <button
              type="button"
              disabled={memory.busy}
              onClick={() => void memory.clear()}
              style={{ fontSize: 11.5, color: "#8a8f99", padding: "10px 0 0" }}
            >
              清空记忆
            </button>
          ) : null}
        </div>

        <div className="m-sec">
          <h3>固定人设</h3>
        </div>
        <div className="m-panel" style={{ padding: "4px 14px 10px" }}>
          {Object.entries(preferences?.preferences ?? {}).map(([key, value]) => (
            <div className="m-spec" key={key}>
              <b>{key}</b>
              <span style={{ color: "#55595f" }}>{String(value)}</span>
            </div>
          ))}
          <div style={{ fontSize: 11, color: "#a0a5ae", padding: "10px 0 2px", lineHeight: 1.6 }}>
            这几条来自固定数据，由 <code>get_preferences</code> 随记忆一起交给 Agent。
            上面那些是它自己在对话里攒的。
          </div>
        </div>

        <div className="m-panel" style={{ padding: "12px 14px" }}>
          <div style={{ fontSize: 11.5, color: "#8a8f99", lineHeight: 1.7 }}>
            你的访客身份 <code>{visitorId ?? "…"}</code> 由平台在会话建立时签发（命中预热池时是暖机
            阶段铸好的 EUID）。购物车和记忆都按它隔离，所以别人看到的不是你这一份。
          </div>
          <button
            type="button"
            onClick={onForget}
            style={{ fontSize: 11.5, color: "#8a8f99", paddingTop: 10 }}
          >
            换一个身份（购物车和记忆一起清空）
          </button>
        </div>
      </div>
    </>
  );
}

function DetailView({
  productId,
  onBack,
  onAdd,
  onAsk,
  busy,
}: {
  productId: string;
  onBack: () => void;
  onAdd: (id: string) => void;
  onAsk: (text: string) => void;
  busy: boolean;
}) {
  const [product, setProduct] = useState<(Product & { long_description?: string | null; specs?: Record<string, string> }) | null>(null);

  useEffect(() => {
    let cancelled = false;
    void fetch("/api/backend/product-details", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ product_id: productId }),
    })
      .then((r) => r.json())
      .then((data: { product?: Product }) => {
        if (!cancelled) setProduct((data.product as never) ?? null);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [productId]);

  if (!product) {
    return (
      <div className="m-body">
        <div className="m-empty">加载中…</div>
      </div>
    );
  }

  const specs = { ...(product.specs ?? {}), ...(product.attributes ?? {}) };

  return (
    <>
      <div className="m-body" style={{ paddingBottom: 0 }}>
        <div className="m-detail-hero">
          <button type="button" className="m-back" onClick={onBack} aria-label="返回">
            <IconBack />
          </button>
          <ProductArt
            productId={product.product_id}
            category={product.category}
            badge={product.in_stock === false ? "缺货" : null}
          />
        </div>
        <div className="m-detail-body">
          <div className="m-detail-price">
            <Price value={product.price} currency={product.currency} />
          </div>
          <div className="m-detail-title">{product.title}</div>
          <div style={{ display: "flex", gap: 8, alignItems: "center", fontSize: 11.5, color: "#8a8f99" }}>
            {product.rating ? (
              <span style={{ display: "flex", gap: 3, alignItems: "center" }}>
                <IconStar />
                {product.rating.toFixed(1)}
              </span>
            ) : null}
            <span>{reviewLabel(product.review_count)}</span>
            {product.brand ? <span>· {product.brand}</span> : null}
          </div>
          {product.short_description ? (
            <p className="m-detail-desc" style={{ marginTop: 10 }}>
              {product.long_description ?? product.short_description}
            </p>
          ) : null}

          {Object.keys(specs).length > 0 ? (
            <div className="m-specs">
              {Object.entries(specs).slice(0, 8).map(([key, value]) => (
                <div className="m-spec" key={key}>
                  <b>{key}</b>
                  <span>{String(value)}</span>
                </div>
              ))}
            </div>
          ) : null}

          <button
            type="button"
            className="m-btn"
            data-variant="ghost"
            style={{ width: "100%", marginTop: 14, marginBottom: 6 }}
            onClick={() => onAsk(`Tell me about ${product.title} — is it a good fit for me?`)}
          >
            问问 AI 导购这件值不值得买
          </button>
        </div>
      </div>
      <div className="m-bar">
        <div className="m-bar-total">
          {product.in_stock === false ? "暂时缺货" : "现货"}
          <b>{money(product.price, product.currency)}</b>
        </div>
        <button type="button" className="m-btn" disabled={busy || product.in_stock === false} onClick={() => onAdd(product.product_id)}>
          加入购物车
        </button>
      </div>
    </>
  );
}

// ── The app ──────────────────────────────────────────────────────────────────

export function ShoppingApp({
  initialProducts,
  categories,
  counts,
  total,
  conversation,
  openers,
  settleToken,
  visitorId,
  onForget,
}: {
  initialProducts: Product[];
  categories: string[];
  counts: Record<string, number>;
  total: number;
  conversation: Conversation;
  openers: string[];
  /** 一轮结束时自增——agent 可能写过购物车或记忆。 */
  settleToken: number;
  visitorId: string | null;
  onForget: () => void;
}) {
  const [tab, setTab] = useState<Tab>("home");
  const [detail, setDetail] = useState<string | null>(null);
  const [sheet, setSheet] = useState(false);
  const [category, setCategory] = useState("all");
  const [query, setQuery] = useState("");
  const [products, setProducts] = useState<Product[]>(initialProducts);
  const [shown, setShown] = useState(total);
  const [loading, setLoading] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const [preferences, setPreferences] = useState<UserPreferences | null>(null);
  const [orders, setOrders] = useState<Order[]>([]);
  const cart = useCart(visitorId);
  const memory = useMemory(visitorId, settleToken);

  useEffect(() => {
    if (settleToken > 0) cart.reload();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [settleToken]);

  useEffect(() => {
    if (!toast) return;
    const timer = setTimeout(() => setToast(null), 2000);
    return () => clearTimeout(timer);
  }, [toast]);

  // "all" is already in the first paint from the server render; refetching it on
  // mount would blank the grid for a beat.
  useEffect(() => {
    if (category === "all") {
      setProducts(initialProducts);
      setShown(total);
      return;
    }
    setLoading(true);
    void fetch(`/api/storefront/browse?category=${encodeURIComponent(category)}`)
      .then((r) => r.json())
      .then((data: { products?: Product[]; total?: number }) => {
        setProducts(data.products ?? []);
        setShown(data.total ?? 0);
      })
      .catch(() => setProducts([]))
      .finally(() => setLoading(false));
  }, [category, initialProducts, total]);

  useEffect(() => {
    if (tab !== "me" || !visitorId) return;
    const headers = { "Content-Type": "application/json", ...visitorHeaders(visitorId) };
    void fetch("/api/backend/preferences", { method: "POST", headers, body: "{}" })
      .then((r) => r.json())
      .then((d: { preferences?: UserPreferences }) => setPreferences(d.preferences ?? null))
      .catch(() => {});
    void fetch("/api/backend/orders/list", { method: "POST", headers, body: "{}" })
      .then((r) => r.json())
      .then((d: { orders?: Order[] }) => setOrders(d.orders ?? []))
      .catch(() => {});
  }, [tab, visitorId]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return products;
    return products.filter((p) =>
      `${p.title} ${p.brand ?? ""} ${p.short_description ?? ""}`.toLowerCase().includes(q),
    );
  }, [products, query]);

  const add = useCallback(
    async (productId: string) => {
      await cart.add(productId, 1);
      setToast("已加入购物车");
    },
    [cart],
  );

  const ask = useCallback(
    (text: string) => {
      setSheet(true);
      conversation.send(text);
    },
    [conversation],
  );

  const openSheet = () => {
    setSheet(true);
    conversation.start();
  };

  return (
    <div className="m-app">
      <StatusBar dark={tab === "cart" || tab === "category" || detail !== null} />

      {detail ? (
        <DetailView
          productId={detail}
          onBack={() => setDetail(null)}
          onAdd={add}
          onAsk={ask}
          busy={cart.busy}
        />
      ) : tab === "home" ? (
        <HomeTab
          products={filtered}
          categories={categories}
          total={shown}
          loading={loading}
          category={category}
          onCategory={setCategory}
          onOpen={setDetail}
          query={query}
          onQuery={setQuery}
        />
      ) : tab === "category" ? (
        <CategoryTab
          categories={categories}
          counts={counts}
          onPick={(c) => {
            setCategory(c);
            setTab("home");
          }}
        />
      ) : tab === "cart" ? (
        <CartTab
          cart={cart}
          busy={cart.busy}
          onUpdate={(id, qty) => void cart.update(id, qty)}
          onRemove={(id) => void cart.remove(id)}
          onToast={setToast}
          onShop={() => setTab("home")}
        />
      ) : (
        <MeTab
          preferences={preferences}
          orders={orders}
          memory={memory}
          visitorId={visitorId}
          onForget={() => {
            onForget();
            setPreferences(null);
            setOrders([]);
            setToast("已换成新身份");
          }}
        />
      )}

      {toast ? <div className="m-toast">{toast}</div> : null}

      {sheet ? (
        <AgentSheet
          conversation={conversation}
          agentName="ACME 导购助手"
          openers={openers}
          onClose={() => setSheet(false)}
          actions={{
            onAdd: (id) => void add(id),
            onOpenProduct: (id) => {
              setSheet(false);
              setDetail(id);
            },
            onPickSuggestion: (text) => conversation.send(text),
          }}
        />
      ) : null}

      {/* Hidden while a detail view is open — that view has its own action bar, and
          stacking two bars puts two competing primary buttons on top of each other.
          Real shopping apps push detail as a full screen for the same reason. */}
      <div className="m-tabs" hidden={detail !== null}>
        <button type="button" className="m-tab" data-active={tab === "home" && !detail} onClick={() => { setTab("home"); setDetail(null); }}>
          <IconHome active={tab === "home" && !detail} />
          首页
        </button>
        <button type="button" className="m-tab" data-active={tab === "category"} onClick={() => { setTab("category"); setDetail(null); }}>
          <IconGrid active={tab === "category"} />
          分类
        </button>
        <button type="button" className="m-tab m-tab-ai" onClick={openSheet}>
          <span className="m-tab-ai-orb">
            <IconSparkle />
          </span>
          <span>AI 导购</span>
        </button>
        <button type="button" className="m-tab" data-active={tab === "cart"} onClick={() => { setTab("cart"); setDetail(null); }}>
          <span style={{ position: "relative" }}>
            <IconCart active={tab === "cart"} />
            {cart.count > 0 ? <span className="m-tab-badge">{cart.count}</span> : null}
          </span>
          购物车
        </button>
        <button type="button" className="m-tab" data-active={tab === "me"} onClick={() => { setTab("me"); setDetail(null); }}>
          <IconUser active={tab === "me"} />
          我的
        </button>
      </div>
    </div>
  );
}
