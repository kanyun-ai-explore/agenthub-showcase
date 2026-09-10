/**
 * Presentation payload shapes, mirroring CMA's own
 * `examples/retail/storefront-web/lib/types.ts` (confirmed structurally identical
 * to this repo's own `shopping_agent.enrichment` output — the same `PRESENTATION_COMPONENTS`
 * component names: products, comparison, plan, guide, order_status, checkout,
 * suggestions). Only the fields this app's simplified card components read are kept.
 */

export interface Product {
  product_id: string;
  title: string;
  brand?: string | null;
  price: number;
  currency?: string;
  rating?: number | null;
  review_count?: number | null;
  image_url?: string | null;
  category?: string | null;
  labels?: string[];
  short_description?: string | null;
  in_stock?: boolean;
}

export interface ProductsPayload {
  title?: string;
  layout?: "carousel" | "grid" | "list";
  items: { product: Product; reason?: string | null }[];
}

export interface ComparisonPayload {
  title?: string;
  entries: {
    product_id: string;
    product: Product;
    pros?: string[];
    cons?: string[];
    best_for?: string | null;
  }[];
  recommended_product_id?: string | null;
}

export interface PlanPayload {
  title: string;
  intro?: string;
  steps: { label: string; detail?: string | null; products: Product[] }[];
}

export interface GuidePayload {
  title: string;
  sections: { heading: string; body: string }[];
  related_products?: Product[];
  sources?: string[];
}

export interface OrderStatusPayload {
  order_id: string;
  summary: string;
  next_step?: string;
  order?: {
    order_id: string;
    status: string;
    placed_at: string;
    items: { product_id: string; title: string; quantity: number; price: number }[];
    total: number;
    currency?: string;
    estimated_delivery?: string;
  };
}

export interface CheckoutPayload {
  note?: string;
  fulfillment_method?: "delivery" | "pickup" | "shipping";
  cart: {
    items: { product_id: string; title: string; price: number; quantity: number }[];
    item_count: number;
    subtotal: number;
    currency: string;
  };
}

export interface SuggestionsPayload {
  suggestions: string[];
}

// ── Merchant-side components ────────────────────────────────────────────────
// The merchant agent has its own presentation set (`merchant_agent/enrichment.py`'s
// `PRESENTATION_COMPONENTS`): metrics, digest, change_preview, plus the shared
// `suggestions`. Shapes below are the ENRICHED payloads — what the executor emits
// after joining tool-returned records onto the model's picks, which is what reaches
// the card. Captured from a real turn.

export interface MetricsPayload {
  title?: string;
  period?: string;
  metrics: {
    metric: string;
    value: number;
    change_pct?: number | null;
    note?: string | null;
    currency?: string | null;
  }[];
}

export interface DigestPayload {
  title?: string;
  items: {
    kind: "low_stock" | "slow_mover" | "order_issue" | "metric" | "pending_change" | "note";
    ref_id?: string | null;
    headline: string;
    why_it_matters?: string | null;
    /** Joined by the executor when a tool returned that record this session. */
    listing?: { listing_id?: string; title?: string; price?: number; stock?: number } | null;
    change?: StagedChangeSummary | null;
  }[];
}

/** Only the fields the preview card reads; the staged record carries more. */
export interface StagedChangeSummary {
  change_id: string;
  kind: string;
  status: string;
  summary: string;
  /** One diff line: which listing, which field, and the two values. Shape read off a
   * real staged promotion (`chg-0002`) — `target` is the
   * listing id and `field` the attribute, e.g. `promotion_price`. */
  items?: { target?: string; field?: string; before?: unknown; after?: unknown }[];
  guardrail_notes?: string[];
  currency?: string | null;
  margin_before_pct?: number | null;
  margin_after_pct?: number | null;
}

export interface ChangePreviewPayload {
  change_id: string;
  headline?: string;
  note?: string;
  change: StagedChangeSummary;
}

/** The envelope every mode-A/mode-B presentation delivery carries — see
 * `storefront_stdio_server/__main__.py`'s `call_tool` handler (the merchant server
 * builds the identical shape). */
export interface UiEnvelope {
  displayed: true;
  /** The names with a card component today are products / comparison / plan /
   * guide / order_status / checkout / suggestions (shopping) and metrics / digest
   * / change_preview (merchant) — see `isKnownComponent`. Typed as a plain string
   * because the agent decides this, not us: an unrecognised name must render as a
   * visible fallback, not vanish (it used to vanish). */
  component: string;
  payload: unknown;
  notes?: string;
}
