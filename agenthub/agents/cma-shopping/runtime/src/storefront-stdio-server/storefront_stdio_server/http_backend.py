"""HTTP ``StorefrontBackend`` adapter (reproduction plan §6 contract a). New code for
this repo, not vendored CMA source — it implements CMA's own ``StorefrontBackend``
abstract interface exactly the way ``examples/retail/api/mock_retail.py`` (upstream)
or any real adopter's backend would, just over HTTP instead of in-process.

Wire contract, one POST per method, all against ``BACKEND_BASE_URL``:

- Every request carries ``X-CMA-User: <CMA_END_USER_ID>``. This is this server's own
  header, set from the *session's* env — never from a tool argument the model wrote —
  so the backend decides what that identity may see the same way ``ShoppingSessionContext``
  does today; a compromised or confused model turn cannot widen it. When
  ``BACKEND_TOKEN`` is set (a secretRef in ``agent.yaml``), it also carries
  ``Authorization: Bearer <BACKEND_TOKEN>``.
- 2xx: a JSON body per method (see each method below); a ``null`` where the Python
  method itself returns ``None`` is a normal result (an unknown id), not an error.
- 409: ``{"error": "unavailable", "detail": str}`` -> raises :class:`Unavailable`.
- 422: ``{"error": "not_offered", "detail": str}`` -> raises :class:`NotOffered`.
- Any other non-2xx, a timeout, or a connection failure is left to propagate as-is.
  ``BaseToolExecutor.execute``'s own generic failure ladder already turns an
  uncaught exception into "{tool} is temporarily unavailable" for the model and logs
  it server-side, so this adapter does not need a catch-all of its own — adding one
  would just be a second, easier-to-drift copy of that ladder.

See ``apps/storefront-web/app/api/backend/`` for the endpoint table and
``apps/storefront-web/app/api/backend/**`` for the reference server implementing it.
"""

from __future__ import annotations

from typing import Any

import httpx
from shopping_agent.backend import NotOffered, StorefrontBackend, Unavailable
from shopping_agent.types import (
    Cart,
    CheckoutHandoff,
    Disclosure,
    FulfillmentOption,
    Order,
    Policy,
    Product,
    ProductDetails,
    SearchFilters,
    ShoppingSessionContext,
    UserPreferences,
)


def _error_detail(response: httpx.Response) -> str:
    try:
        body = response.json()
    except ValueError:
        return response.text[:200] or f"HTTP {response.status_code}"
    detail = body.get("detail") if isinstance(body, dict) else None
    return str(detail) if detail else f"HTTP {response.status_code}"


class HttpStorefrontBackend(StorefrontBackend):
    """``client`` is a shared ``httpx.AsyncClient`` (base_url already set to
    ``BACKEND_BASE_URL``, one per server process — see ``__main__.py``). ``user_id`` is
    this session's ``CMA_END_USER_ID``, fixed at construction time: the identity a
    stdio-server process serves never changes mid-process (a fresh process starts per
    turn, D-R2), so there is no call site where it could legitimately differ from what
    the session started with."""

    def __init__(self, client: httpx.AsyncClient, *, user_id: str, token: str | None = None) -> None:
        self._client = client
        self._user_id = user_id
        self._headers = {"X-CMA-User": user_id}
        if token:
            self._headers["Authorization"] = f"Bearer {token}"

    async def _post(self, path: str, body: dict[str, Any]) -> Any:
        response = await self._client.post(path, json=body, headers=self._headers)
        if response.status_code == 409:
            raise Unavailable(_error_detail(response))
        if response.status_code == 422:
            raise NotOffered(_error_detail(response))
        response.raise_for_status()
        return response.json()

    async def search_products(
        self,
        session: ShoppingSessionContext,
        query: str,
        filters: SearchFilters | None = None,
        limit: int = 8,
    ) -> list[Product]:
        data = await self._post(
            "/backend/search-products",
            {
                "query": query,
                "filters": filters.model_dump(mode="json") if filters else None,
                "limit": limit,
            },
        )
        return [Product.model_validate(item) for item in data["products"]]

    async def get_product_details(
        self, session: ShoppingSessionContext, product_id: str
    ) -> ProductDetails | None:
        data = await self._post("/backend/product-details", {"product_id": product_id})
        product = data.get("product")
        return ProductDetails.model_validate(product) if product else None

    async def get_cart(self, session: ShoppingSessionContext) -> Cart:
        data = await self._post("/backend/cart/get", {})
        return Cart.model_validate(data["cart"])

    async def add_to_cart(
        self, session: ShoppingSessionContext, product_id: str, quantity: int
    ) -> Cart:
        data = await self._post(
            "/backend/cart/add", {"product_id": product_id, "quantity": quantity}
        )
        return Cart.model_validate(data["cart"])

    async def update_cart_item(
        self, session: ShoppingSessionContext, product_id: str, quantity: int
    ) -> Cart:
        data = await self._post(
            "/backend/cart/update", {"product_id": product_id, "quantity": quantity}
        )
        return Cart.model_validate(data["cart"])

    async def remove_from_cart(self, session: ShoppingSessionContext, product_id: str) -> Cart:
        data = await self._post("/backend/cart/remove", {"product_id": product_id})
        return Cart.model_validate(data["cart"])

    async def get_preferences(self, session: ShoppingSessionContext) -> UserPreferences:
        data = await self._post("/backend/preferences", {})
        return UserPreferences.model_validate(data["preferences"])

    async def checkout_handoff(
        self, session: ShoppingSessionContext, cart: Cart
    ) -> list[CheckoutHandoff]:
        data = await self._post(
            "/backend/checkout-handoff", {"cart": cart.model_dump(mode="json")}
        )
        return [CheckoutHandoff.model_validate(item) for item in data.get("handoffs", [])]

    async def get_account_context(self, session: ShoppingSessionContext) -> dict[str, Any] | None:
        data = await self._post("/backend/account-context", {})
        return data.get("account")

    async def get_orders(self, session: ShoppingSessionContext, limit: int = 5) -> list[Order]:
        data = await self._post("/backend/orders/list", {"limit": limit})
        return [Order.model_validate(item) for item in data["orders"]]

    async def get_order(self, session: ShoppingSessionContext, order_id: str) -> Order | None:
        data = await self._post("/backend/orders/get", {"order_id": order_id})
        order = data.get("order")
        return Order.model_validate(order) if order else None

    async def search_policies(self, session: ShoppingSessionContext, query: str) -> list[Policy]:
        data = await self._post("/backend/policies", {"query": query})
        return [Policy.model_validate(item) for item in data["policies"]]

    async def get_disclosure(
        self, session: ShoppingSessionContext, product_id: str
    ) -> Disclosure | None:
        data = await self._post("/backend/disclosure", {"product_id": product_id})
        disclosure = data.get("disclosure")
        return Disclosure.model_validate(disclosure) if disclosure else None

    async def get_fulfillment_options(
        self, session: ShoppingSessionContext, product_ids: list[str]
    ) -> list[FulfillmentOption]:
        data = await self._post("/backend/fulfillment", {"product_ids": product_ids})
        return [FulfillmentOption.model_validate(item) for item in data["options"]]
