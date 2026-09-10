/**
 * File-backed cart persistence, keyed by `user_id` (the `X-CMA-User` header) —
 * **not** by chat/session id the way CMA's own `MockRetail` (`SessionCarts`) keys
 * its in-memory carts. This is a deliberate divergence, not a port bug: a chat
 * session is disposable and per-conversation, while a `StorefrontBackend`
 * implementation is standing in for a real retailer's cart service, which persists
 * per *customer account*. Scoping by user id also gives cross-session cart
 * persistence a place to live, which the plan's D-R2 note calls out as worth
 * demonstrating. See `runtime/tests/smoke_http_backend.py` for the smoke check that two distinct
 * `X-CMA-User` values get two distinct carts.
 */

import type { Cart, CartItem, ProductDetails } from "./types";
import { CARTS_FILE } from "./paths";
import { updateJsonFile } from "./file-store";
import { UnavailableError } from "./errors";
import { findProduct, listingOf, type CatalogIndex } from "./catalog";

type CartsFile = Record<string, Cart>;

function emptyCart(): Cart {
  return { items: [], currency: "CNY" };
}

/**
 * Re-key one customer's cart onto another id, merging quantities on the same
 * product. Used when a visitor's session adopts the platform-minted EUID: whatever
 * they put in the cart under the browser-local id before the sandbox came up must
 * follow them, or the badge drops to 0 the moment the AI session is ready.
 */
export async function moveCart(fromUserId: string, toUserId: string): Promise<Cart> {
  if (fromUserId === toUserId) return getCart(toUserId);
  return updateJsonFile<CartsFile, Cart>(CARTS_FILE, {}, (carts) => {
    const from = carts[fromUserId];
    const to = carts[toUserId] ?? emptyCart();
    if (!from || from.items.length === 0) return { next: carts, result: to };
    const merged: CartItem[] = to.items.map((item) => ({ ...item }));
    for (const item of from.items) {
      const existing = merged.find((m) => m.product_id === item.product_id);
      if (existing) existing.quantity += item.quantity;
      else merged.push({ ...item });
    }
    const next = { ...carts, [toUserId]: { ...to, items: merged } };
    delete next[fromUserId];
    return { next, result: next[toUserId] };
  });
}

export async function getCart(userId: string): Promise<Cart> {
  return updateJsonFile<CartsFile, Cart>(CARTS_FILE, {}, (carts) => ({
    next: carts,
    result: carts[userId] ?? emptyCart(),
  }));
}

function unavailableDetail(product: ProductDetails, family: ProductDetails | null): string {
  if (family && family.product_id !== product.product_id) {
    const inStock = family.variants.filter((v) => v.in_stock).map((v) => v.product_id);
    const listed = inStock.length > 0 ? inStock.slice(0, 6).join(", ") : "no other variant";
    return `${product.product_id} is out of stock; in-stock variants of ${family.product_id}: ${listed}`;
  }
  return `${product.product_id} is out of stock`;
}

function toLine(product: ProductDetails, quantity: number): CartItem {
  return {
    product_id: product.product_id,
    title: product.title,
    price: product.price,
    quantity,
    image_url: product.image_url,
    option_values: product.option_values,
    variant_of: product.variant_of,
  };
}

/** Throws `UnavailableError` (out of stock) — the caller maps that to a 409, which
 * `HttpStorefrontBackend._post` re-raises as CMA's own `Unavailable`. A missing or
 * family (multi-option) product id is the executor's own provenance/family gate's
 * job to have already refused before this backend is called; reaching here with one
 * is a deployment bug, so it is a plain 500 (an uncaught `TypeError`), not a
 * modeled error code — mirrors `MockRetail.add_to_cart`'s own `raise KeyError`. */
export async function addToCart(
  catalog: CatalogIndex,
  userId: string,
  productId: string,
  quantity: number,
): Promise<Cart> {
  const product = findProduct(catalog, productId);
  if (!product || Object.keys(product.options).length > 0) {
    throw new TypeError(`addToCart: ${productId} is missing or is a family record`);
  }
  if (!product.in_stock) {
    throw new UnavailableError(unavailableDetail(product, listingOf(catalog, productId)));
  }
  return updateJsonFile<CartsFile, Cart>(CARTS_FILE, {}, (carts) => {
    const cart = carts[userId] ?? emptyCart();
    const existing = cart.items.find((i) => i.product_id === productId);
    const nextQuantity = quantity + (existing?.quantity ?? 0);
    const items = cart.items.filter((i) => i.product_id !== productId);
    items.push(toLine(product, nextQuantity));
    const nextCart: Cart = { items, currency: cart.currency };
    return { next: { ...carts, [userId]: nextCart }, result: nextCart };
  });
}

export async function updateCartItem(userId: string, productId: string, quantity: number): Promise<Cart> {
  return updateJsonFile<CartsFile, Cart>(CARTS_FILE, {}, (carts) => {
    const cart = carts[userId] ?? emptyCart();
    const items = cart.items.map((item) =>
      item.product_id === productId ? { ...item, quantity } : item,
    );
    const nextCart: Cart = { items, currency: cart.currency };
    return { next: { ...carts, [userId]: nextCart }, result: nextCart };
  });
}

export async function removeFromCart(userId: string, productId: string): Promise<Cart> {
  return updateJsonFile<CartsFile, Cart>(CARTS_FILE, {}, (carts) => {
    const cart = carts[userId] ?? emptyCart();
    const nextCart: Cart = {
      items: cart.items.filter((i) => i.product_id !== productId),
      currency: cart.currency,
    };
    return { next: { ...carts, [userId]: nextCart }, result: nextCart };
  });
}
