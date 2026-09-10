"use client";

/**
 * 购物车，走 `/api/backend/cart/*` —— 和 shopping agent 的 MCP 打的是同一组路由，
 * 带同一个 `X-CMA-User`。这是「货架和 agent 共用一个后端」这句话的实处。
 */

import { useCallback, useEffect, useState } from "react";
import type { Cart } from "@/lib/backend/types";
import { visitorHeaders } from "@/lib/showcase/visitor";

export interface CartApi {
  cart: Cart | null;
  count: number;
  subtotal: number;
  busy: boolean;
  add: (productId: string, quantity?: number) => Promise<void>;
  update: (productId: string, quantity: number) => Promise<void>;
  remove: (productId: string) => Promise<void>;
  reload: () => void;
}

export function useCart(visitorId: string | null): CartApi {
  const [cart, setCart] = useState<Cart | null>(null);
  const [busy, setBusy] = useState(false);
  const [token, setToken] = useState(0);

  const call = useCallback(
    async (path: string, body: unknown): Promise<Cart | null> => {
      const res = await fetch(path, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...visitorHeaders(visitorId) },
        body: JSON.stringify(body),
      });
      if (!res.ok) return null;
      const data = (await res.json()) as { cart?: Cart };
      return data.cart ?? null;
    },
    [visitorId],
  );

  useEffect(() => {
    if (!visitorId) return;
    let cancelled = false;
    void call("/api/backend/cart/get", {}).then((next) => {
      if (!cancelled && next) setCart(next);
    });
    return () => {
      cancelled = true;
    };
  }, [call, visitorId, token]);

  const mutate = useCallback(
    async (path: string, body: unknown) => {
      setBusy(true);
      try {
        const next = await call(path, body);
        if (next) setCart(next);
      } finally {
        setBusy(false);
      }
    },
    [call],
  );

  const items = cart?.items ?? [];
  return {
    cart,
    count: items.reduce((n, i) => n + i.quantity, 0),
    subtotal: items.reduce((n, i) => n + i.price * i.quantity, 0),
    busy,
    add: (productId, quantity = 1) =>
      mutate("/api/backend/cart/add", { product_id: productId, quantity }),
    update: (productId, quantity) =>
      quantity <= 0
        ? mutate("/api/backend/cart/remove", { product_id: productId })
        : mutate("/api/backend/cart/update", { product_id: productId, quantity }),
    remove: (productId) => mutate("/api/backend/cart/remove", { product_id: productId }),
    reload: () => setToken((v) => v + 1),
  };
}
