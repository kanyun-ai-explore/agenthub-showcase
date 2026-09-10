/**
 * TypeScript mirrors of `shopping_agent.types` (the pydantic models the Python
 * `StorefrontBackend` methods take and return) — only the fields this embedded
 * backend actually reads or writes. These are the wire shapes for
 * `app/api/backend/**` (reproduction plan §6 contract a); the Python side
 * (`storefront_stdio_server/http_backend.py`) validates each response back into the
 * real pydantic models, so a field typo here surfaces as a `pydantic.ValidationError`
 * server-side rather than a silent mismatch.
 */

export interface Product {
  product_id: string;
  title: string;
  brand?: string | null;
  price: number;
  currency: string;
  rating?: number | null;
  review_count?: number | null;
  image_url?: string | null;
  category?: string | null;
  labels: string[];
  attributes: Record<string, string>;
  in_stock: boolean;
  short_description?: string | null;
  options: Record<string, string[]>;
  option_values: Record<string, string>;
  variant_of?: string | null;
}

export interface ProductDetails extends Product {
  long_description?: string | null;
  specs: Record<string, string>;
  review_highlights: string[];
  variants: Product[];
}

export interface SearchFilters {
  category?: string | null;
  min_price?: number | null;
  max_price?: number | null;
  min_rating?: number | null;
  attributes: Record<string, string>;
  sort: "relevance" | "price_asc" | "price_desc" | "rating";
}

export interface CartItem {
  product_id: string;
  title: string;
  price: number;
  quantity: number;
  image_url?: string | null;
  option_values: Record<string, string>;
  variant_of?: string | null;
}

export interface Cart {
  items: CartItem[];
  currency: string;
}

export interface CheckoutHandoff {
  url: string;
  label?: string | null;
  seller?: string | null;
}

export interface UserPreferences {
  user_id: string;
  display_name?: string | null;
  loyalty_tier?: string | null;
  default_location?: string | null;
  preferences: Record<string, string>;
}

export type OrderStatus =
  | "processing"
  | "shipped"
  | "out_for_delivery"
  | "delivered"
  | "delayed"
  | "cancelled"
  | "return_initiated"
  | "refunded";

export interface OrderItem {
  product_id: string;
  title: string;
  quantity: number;
  price: number;
  option_values: Record<string, string>;
  variant_of?: string | null;
}

export interface Order {
  order_id: string;
  status: OrderStatus;
  placed_at: string;
  items: OrderItem[];
  total: number;
  currency: string;
  estimated_delivery?: string | null;
  tracking_url?: string | null;
}

export interface Policy {
  policy_id: string;
  title: string;
  category?: string | null;
  content: string;
}

export interface Disclosure {
  title: string;
  product_id: string;
  rows: { label: string; value: string; note?: string | null }[];
  sources: string[];
  footnotes: string[];
}

export interface FulfillmentOption {
  method: "delivery" | "pickup" | "shipping";
  eta: string;
  fee: number;
  location?: string | null;
}

/** `commerce_common.types.MemoryFact` (contract c). */
export interface MemoryFact {
  key: string;
  value: string;
  category: "preference" | "constraint" | "context";
  updated_at?: string | null;
  source_session_id?: string | null;
}
