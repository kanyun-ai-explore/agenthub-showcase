"use client";

/**
 * 导购 agent 的展示组件。
 *
 * 这是整个演示的落点：agent 返回的是 `{component, payload}` 而不是 HTML，这个文件
 * 只是其中一种渲染方式，换个端可以画得完全不同。数据形状见 lib/generative/types.ts。
 */

import type {
  CheckoutPayload,
  ComparisonPayload,
  GuidePayload,
  OrderStatusPayload,
  PlanPayload,
  Product,
  ProductsPayload,
} from "@/lib/generative/types";
import { ProductArt } from "@/components/mobile/ProductArt";
import { money, priceParts } from "./format";

export interface CardActions {
  /** 直接从卡片加购，写的是货架那一个购物车。 */
  onAdd?: (productId: string) => void;
  onOpenProduct?: (productId: string) => void;
  onPickSuggestion?: (text: string) => void;
}

function Price({ value, currency }: { value: number; currency?: string }) {
  const [symbol, digits] = priceParts(value, currency ?? "CNY");
  return (
    <span className="m-price">
      <small>{symbol}</small>
      {digits}
    </span>
  );
}

function MiniProduct({
  product,
  reason,
  actions,
}: {
  product: Product;
  reason?: string | null;
  actions: CardActions;
}) {
  return (
    <button
      type="button"
      className="g-mini"
      onClick={() => actions.onOpenProduct?.(product.product_id)}
    >
      <ProductArt
        productId={product.product_id}
        category={product.category}
        badge={product.in_stock === false ? "缺货" : null}
      />
      <div className="g-mini-title">{product.title}</div>
      <Price value={product.price} currency={product.currency} />
      {reason ? <div className="g-mini-why">{reason}</div> : null}
    </button>
  );
}

export function ProductsCard({ payload, actions }: { payload: ProductsPayload; actions: CardActions }) {
  const items = payload.items ?? [];
  return (
    <div className="g-card">
      <div className="g-card-head">
        <b>{payload.title ?? "为你挑的"}</b>
        <span className="g-kind">products</span>
      </div>
      <div className="g-body-flush">
        <div className="g-scroller">
          {items.map(({ product, reason }) => (
            <MiniProduct key={product.product_id} product={product} reason={reason} actions={actions} />
          ))}
        </div>
        {actions.onAdd && items.length > 0 ? (
          <div style={{ padding: "10px 13px 0" }}>
            <button
              type="button"
              className="m-btn"
              data-variant="ghost"
              style={{ width: "100%", padding: "8px 0", fontSize: 12.5 }}
              onClick={() => actions.onAdd?.(items[0].product.product_id)}
            >
              把第一件加入购物车
            </button>
          </div>
        ) : null}
      </div>
    </div>
  );
}

export function ComparisonCard({ payload }: { payload: ComparisonPayload }) {
  const entries = payload.entries ?? [];
  return (
    <div className="g-card">
      <div className="g-card-head">
        <b>{payload.title ?? "对比"}</b>
        <span className="g-kind">comparison</span>
      </div>
      <div className="g-body">
        {entries.map((entry) => {
          const best = payload.recommended_product_id === entry.product_id;
          return (
            <div key={entry.product_id} className={best ? "g-best" : undefined} style={best ? { marginTop: 8 } : undefined}>
              {best ? <div className="g-best-tag">推荐</div> : null}
              <div className="g-row" style={best ? { borderTop: 0, paddingTop: 4 } : undefined}>
                <div style={{ width: 46, flex: "none" }}>
                  <ProductArt
                    productId={entry.product.product_id}
                    category={entry.product.category}
                    style={{ borderRadius: 9, height: 46 }}
                  />
                </div>
                <div className="g-row-main">
                  <div className="g-row-title">{entry.product.title}</div>
                  <Price value={entry.product.price} currency={entry.product.currency} />
                  {entry.best_for ? (
                    <div style={{ fontSize: 11.5, color: "#7b808a", marginTop: 3 }}>{entry.best_for}</div>
                  ) : null}
                  {entry.pros?.length ? (
                    <ul className="g-list">
                      {entry.pros.slice(0, 3).map((pro) => (
                        <li key={pro} className="g-pro">
                          {pro}
                        </li>
                      ))}
                    </ul>
                  ) : null}
                  {entry.cons?.length ? (
                    <ul className="g-list">
                      {entry.cons.slice(0, 2).map((con) => (
                        <li key={con}>{con}</li>
                      ))}
                    </ul>
                  ) : null}
                </div>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

export function PlanCard({ payload, actions }: { payload: PlanPayload; actions: CardActions }) {
  return (
    <div className="g-card">
      <div className="g-card-head">
        <b>{payload.title}</b>
        <span className="g-kind">plan</span>
      </div>
      <div className="g-body">
        {payload.intro ? (
          <p style={{ margin: "0 0 8px", fontSize: 12, color: "#7b808a", lineHeight: 1.65 }}>{payload.intro}</p>
        ) : null}
        {(payload.steps ?? []).map((step, index) => (
          <div className="g-step" key={`${step.label}-${index}`}>
            <div className="g-step-n">{index + 1}</div>
            <div>
              <div className="g-step-label">{step.label}</div>
              {step.detail ? <div className="g-step-detail">{step.detail}</div> : null}
              {step.products?.length ? (
                <div className="g-scroller" style={{ padding: "8px 0 0" }}>
                  {step.products.map((product) => (
                    <MiniProduct key={product.product_id} product={product} actions={actions} />
                  ))}
                </div>
              ) : null}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

export function GuideCard({ payload, actions }: { payload: GuidePayload; actions: CardActions }) {
  return (
    <div className="g-card">
      <div className="g-card-head">
        <b>{payload.title}</b>
        <span className="g-kind">guide</span>
      </div>
      <div className="g-body">
        {(payload.sections ?? []).map((section) => (
          <div key={section.heading} style={{ marginBottom: 10 }}>
            <div style={{ fontSize: 12.5, fontWeight: 620, marginBottom: 3 }}>{section.heading}</div>
            <div style={{ fontSize: 12, color: "#6b7079", lineHeight: 1.68 }}>{section.body}</div>
          </div>
        ))}
        {payload.related_products?.length ? (
          <div className="g-scroller" style={{ padding: "2px 0 0" }}>
            {payload.related_products.map((product) => (
              <MiniProduct key={product.product_id} product={product} actions={actions} />
            ))}
          </div>
        ) : null}
      </div>
    </div>
  );
}

export function OrderStatusCard({ payload }: { payload: OrderStatusPayload }) {
  const order = payload.order;
  return (
    <div className="g-card">
      <div className="g-card-head">
        <b>订单 {payload.order_id}</b>
        <span className="g-kind">order_status</span>
      </div>
      <div className="g-body">
        <div style={{ fontSize: 12.5, lineHeight: 1.65 }}>{payload.summary}</div>
        {payload.next_step ? (
          <div style={{ fontSize: 11.5, color: "#7b808a", marginTop: 5 }}>{payload.next_step}</div>
        ) : null}
        {order ? (
          <div style={{ marginTop: 10 }}>
            {(order.items ?? []).map((item) => (
              <div className="g-row" key={item.product_id}>
                <div className="g-row-main">
                  <div className="g-row-title">{item.title}</div>
                  <div style={{ fontSize: 11, color: "#8a8f99" }}>×{item.quantity}</div>
                </div>
                <div style={{ fontSize: 12.5, fontWeight: 620 }}>{money(item.price, order.currency)}</div>
              </div>
            ))}
            <div className="g-row" style={{ fontWeight: 650 }}>
              <div className="g-row-main">
                <div className="g-row-title">
                  合计 {order.estimated_delivery ? `· 预计 ${order.estimated_delivery} 送达` : ""}
                </div>
              </div>
              <Price value={order.total} currency={order.currency} />
            </div>
          </div>
        ) : null}
      </div>
    </div>
  );
}

export function CheckoutCard({ payload }: { payload: CheckoutPayload }) {
  const cart = payload.cart;
  return (
    <div className="g-card">
      <div className="g-card-head">
        <b>结算单</b>
        <span className="g-kind">checkout</span>
      </div>
      <div className="g-body">
        {(cart?.items ?? []).map((item) => (
          <div className="g-row" key={item.product_id}>
            <div className="g-row-main">
              <div className="g-row-title">{item.title}</div>
              <div style={{ fontSize: 11, color: "#8a8f99" }}>×{item.quantity}</div>
            </div>
            <div style={{ fontSize: 12.5, fontWeight: 620 }}>
              {money(item.price * item.quantity, cart?.currency)}
            </div>
          </div>
        ))}
        <div className="g-row">
          <div className="g-row-main">
            <div className="g-row-title">
              小计 · {cart?.item_count ?? 0} 件
              {payload.fulfillment_method ? ` · ${payload.fulfillment_method}` : ""}
            </div>
          </div>
          <Price value={cart?.subtotal ?? 0} currency={cart?.currency} />
        </div>
        {payload.note ? (
          <div style={{ fontSize: 11.5, color: "#7b808a", marginTop: 6 }}>{payload.note}</div>
        ) : null}
      </div>
    </div>
  );
}

export function SuggestionsCard({
  suggestions,
  onPick,
  disabled,
}: {
  suggestions: string[];
  onPick?: (text: string) => void;
  disabled?: boolean;
}) {
  if (!suggestions?.length) return null;
  return (
    <div className="g-chips">
      {suggestions.map((text) => (
        <button
          key={text}
          type="button"
          className="g-chip"
          disabled={disabled || !onPick}
          onClick={() => onPick?.(text)}
        >
          {text}
        </button>
      ))}
    </div>
  );
}
