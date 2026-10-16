"""This deployment's ``search_products``: CMA's handler, plus two fixes for searches
that came back with the wrong things and cost the customer an extra model round.

- **A price bound no longer hides the matches.** Both backends (the showcase's
  ``catalog.ts`` ``rankProducts`` and the embedded MockRetail's ``rank_products``)
  apply ``min_price``/``max_price`` as a hard filter *before* ranking, and the
  relevance cutoff (half the best score) is taken over what is left. When every real
  match is over the bound, the result is whatever shares a word with the query: for
  example, "camping tent" with ``max_price`` 600 (the cheapest tent is
  1049) returned a headlamp, and "sleeping bag" with 300 returned a toiletry bag. The
  model then read the header ("if none match, the item was not found") and searched
  again without the bound. Here a bounded search also runs the same query without the
  bound, in the same call: the matches that outrank every in-range one come back first,
  each marked ``outside_price_filter``, then the in-range results that the unbounded
  ranking still counts relevant. CLAUDE.md's stated-constraint rule ("show those items
  with the miss marked") then has what it needs in one round.
- **A query with no English word is answered as such.** The catalog is searched by its
  English text (both backends tokenize ``[a-z0-9]+``), so "露营帐篷" has no tokens and
  returns nothing whatever the store carries. The empty result says so instead of reading as "not
  carried", and the tool description asks for English up front.

The vendored ``ShoppingToolExecutor`` is subclassed, not edited (its README:
"subclassed and passed on as executor_class").
"""

from __future__ import annotations

import asyncio
import re
from typing import Any

from commerce_common.execution import parse_argument
from commerce_common.streaming import ToolOutcome
from shopping_agent.executor import ShoppingToolExecutor
from shopping_agent.fencing import STOREFRONT_FENCE
from shopping_agent.serialization import (
    compact_product,
    search_result_header,
    search_result_text,
)
from shopping_agent.types import Product, SearchFilters

# The unbounded companion search asks for this many, so "not in its results" means
# "below the backend's relevance cutoff" rather than "past the page". 25 is
# ShoppingAgentConfig.max_search_results' own ceiling.
WIDE_LIMIT = 25
# Matches beyond the bound that come back with a bounded search, at most.
MAX_OUTSIDE = 3

_WORD = re.compile(r"[a-z0-9]+")

SEARCH_NO_ENGLISH_HEADER = (
    "Search returned 0 results because the query has no English words: the catalog is "
    "searched by its English text. Search again in English; this result says nothing "
    "about what the store carries."
)

OUTSIDE_NOTE = (
    "Results marked outside_price_filter come first: they break the price filter you set "
    "and match the query better than anything inside it. They are found, not missing: "
    "show them with the miss marked rather than searching again."
)

SEARCH_DESCRIPTION = (
    "Search the catalog; returns products with id, title, brand, price, rating, and "
    "availability; a product with options shows its lowest in-stock price and its "
    "options. Use a specific query and put stated constraints in filters. Run one search "
    "per distinct item a request names. Write the query in English, the catalog's "
    "language, whatever language the customer writes in. A price filter is a ceiling "
    "or floor the customer stated for this item; a share you split from a total budget "
    "is not one. Matches beyond a price filter come back marked outside_price_filter."
)


def _price_miss(product: Product, filters: SearchFilters) -> str | None:
    if filters.max_price is not None and product.price > filters.max_price:
        return f"above max_price {filters.max_price:g}"
    if filters.min_price is not None and product.price < filters.min_price:
        return f"below min_price {filters.min_price:g}"
    return None


class StorefrontToolExecutor(ShoppingToolExecutor):
    async def _search_products(self, tool_input: dict[str, Any]) -> ToolOutcome:
        query = self._sanitize(tool_input.get("query", ""), 300)
        filters = (
            parse_argument(SearchFilters, tool_input["filters"])
            if tool_input.get("filters")
            else None
        )
        limit = self._search_limit(tool_input.get("limit"))
        outside: list[Product] = []
        if filters is None or (filters.min_price is None and filters.max_price is None):
            products = await self._backend.search_products(self._session, query, filters, limit)
        else:
            products, outside = await self._bounded_search(query, filters, limit)
        if not products and not outside and not _WORD.search(query.lower()):
            return ToolOutcome(SEARCH_NO_ENGLISH_HEADER)
        self._state.remember_products([*outside, *products])
        if not outside:
            return ToolOutcome(search_result_text(query, products, self._config.max_fenced_chars))
        results = [
            compact_product(p) | {"outside_price_filter": _price_miss(p, filters)} for p in outside
        ] + [compact_product(p) for p in products]
        payload = {"query": query, "result_count": len(results), "results": results}
        fenced = STOREFRONT_FENCE.fence_payload(payload, self._config.max_fenced_chars)
        return ToolOutcome(f"{search_result_header(len(results))}\n{OUTSIDE_NOTE}\n{fenced}")

    async def _bounded_search(
        self, query: str, filters: SearchFilters, limit: int
    ) -> tuple[list[Product], list[Product]]:
        """(in-range results the unbounded ranking also counts relevant, up to
        MAX_OUTSIDE matches beyond the bound that outrank all of them)."""
        unbounded = filters.model_copy(
            update={"min_price": None, "max_price": None, "sort": "relevance"}
        )
        bounded, wide = await asyncio.gather(
            self._backend.search_products(self._session, query, filters, limit),
            self._backend.search_products(self._session, query, unbounded, WIDE_LIMIT),
        )
        # A short page is the whole relevant set: an in-range result missing from it
        # scored under the unbounded cutoff, i.e. it only surfaced because the bound
        # removed the real matches. A full page proves nothing, so keep everything.
        if len(wide) < WIDE_LIMIT:
            wide_ids = {p.product_id for p in wide}
            bounded = [p for p in bounded if p.product_id in wide_ids]
        outside: list[Product] = []
        for product in wide:
            if _price_miss(product, filters) is None:
                break  # the best match inside the bound; nothing after it outranks it
            outside.append(product)
        return bounded, outside[:MAX_OUTSIDE]
