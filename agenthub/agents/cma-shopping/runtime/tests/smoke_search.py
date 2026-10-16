"""Offline check for storefront_stdio_server's search handler (search.py),
driven as a real MCP stdio client like smoke_stdio.py, against the embedded MockRetail.
Not wired into any test runner; run manually in the same venv as smoke_stdio.py:

    python runtime/tests/smoke_search.py

Exits 0 and prints "ALL CHECKS PASSED" on success; raises on the first failed check.
The first block is the positive control: it calls MockRetail in-process to show the
backend behaviour the handler works around is really there.
"""

from __future__ import annotations

import asyncio
import json
import os
import re
import shutil
import sys
import tempfile
from contextlib import asynccontextmanager
from pathlib import Path

from mcp import ClientSession, StdioServerParameters
from mcp.client.stdio import stdio_client

FAMILY_TENT = "AR-1202"  # 4-Person Family Tent, 1539
BACKPACKING_TENT = "AR-1201"  # 2-Person Backpacking Tent, 1049
HEADLAMP = "AR-1206"  # Rechargeable Headlamp, 239
SLEEPING_BAG = "AR-1203"  # Insulated Sleeping Bag, 629
TOILETRY_BAG = "AR-1806"  # Hanging Toiletry Bag, 189
WATER_FILTER = "AR-1208"  # Gravity Water Filter, 519
DRIP_COFFEE = "AR-1001"  # 12-Cup Drip Coffee Maker, 559
ESPRESSO = "AR-1002"  # Espresso Machine, 2309


def _text(result) -> str:
    assert result.content, "tool result had no content blocks"
    return result.content[0].text


def _results(text: str) -> list[dict]:
    """The fenced JSON payload of a search result."""
    match = re.search(r"\{.*\}", text, re.S)
    assert match, f"no JSON payload in {text!r}"
    return json.loads(match.group(0))["results"]


@asynccontextmanager
async def _session(state_dir: Path):
    server = StdioServerParameters(
        command=sys.executable,
        args=["-m", "storefront_stdio_server"],
        env={**os.environ, "CMA_STATE_DIR": str(state_dir), "CMA_END_USER_ID": "demo-user"},
    )
    async with stdio_client(server) as (read, write):
        async with ClientSession(read, write) as session:
            await session.initialize()
            yield session


async def _control() -> None:
    import storefront_stdio_server
    from shopping_agent.types import SearchFilters, ShoppingSessionContext

    # _examples/ is a sys.path root, as in __main__._build_backend.
    sys.path.insert(0, str(Path(storefront_stdio_server.__file__).parent / "_examples"))
    from retail.api.mock_retail import MockRetail

    backend = MockRetail()
    session = ShoppingSessionContext(user_id="demo-user", session_id="control")
    tents = await backend.search_products(session, "camping tent", SearchFilters(max_price=600))
    ids = [p.product_id for p in tents]
    assert FAMILY_TENT not in ids and BACKPACKING_TENT not in ids, ids
    assert HEADLAMP in ids, f"expected the backend to fill a 600 cap with the headlamp: {ids}"
    bags = await backend.search_products(session, "sleeping bag", SearchFilters(max_price=300))
    bag_ids = [p.product_id for p in bags]
    assert SLEEPING_BAG not in bag_ids and TOILETRY_BAG in bag_ids, bag_ids
    empty = await backend.search_products(session, "露营帐篷", None)
    assert empty == [], empty
    print(
        f"[control] backend alone: 'camping tent' ≤600 -> {ids}; 'sleeping bag' ≤300 -> {bag_ids}; '露营帐篷' -> []"
    )


async def main() -> None:
    await _control()
    tmp = Path(tempfile.mkdtemp(prefix="cma-search-"))
    try:
        async with _session(tmp / "state") as session:
            tools = (await session.list_tools()).tools
            description = next(t for t in tools if t.name == "search_products").description
            assert "in English" in description and "outside_price_filter" in description, (
                description
            )
            print("[1] search_products description: English queries, outside_price_filter")

            # A cap below every tent: the tents come back first, marked; the in-range
            # neighbours the backend filled the cap with follow, unmarked.
            text = _text(
                await session.call_tool(
                    "search_products", {"query": "camping tent", "filters": {"max_price": 600}}
                )
            )
            rows = _results(text)
            marks = [(r["product_id"], r.get("outside_price_filter")) for r in rows]
            assert {pid for pid, _ in marks[:2]} == {FAMILY_TENT, BACKPACKING_TENT}, marks
            assert all(mark == "above max_price 600" for _, mark in marks[:2]), marks
            assert all(mark is None for _, mark in marks[2:]) and HEADLAMP in dict(marks), marks
            # The water filter fills the cap too, but the unbounded ranking drops it
            # below its relevance cutoff, so it does not come back.
            assert WATER_FILTER not in dict(marks), marks
            assert "outside_price_filter come first" in text, text
            print(f"[2] 'camping tent' ≤600 -> {marks}")

            # A marked result entered provenance: it can go in the cart.
            added = await session.call_tool(
                "add_to_cart", {"product_id": FAMILY_TENT, "quantity": 1}
            )
            assert not added.isError and f"Added {FAMILY_TENT}" in _text(added), _text(added)
            print(f"[3] add_to_cart({FAMILY_TENT}) after the bounded search -> ok")

            # The sleeping bag outranks the in-range toiletry bag: it leads, marked.
            rows = _results(
                _text(
                    await session.call_tool(
                        "search_products", {"query": "sleeping bag", "filters": {"max_price": 300}}
                    )
                )
            )
            marks = {r["product_id"]: r.get("outside_price_filter") for r in rows}
            assert marks.get(SLEEPING_BAG) == "above max_price 300", marks
            assert rows[0]["product_id"] == SLEEPING_BAG, [r["product_id"] for r in rows]
            print(f"[4] 'sleeping bag' ≤300 -> {marks}")

            # A cap that the best match fits: nothing beyond it is added.
            rows = _results(
                _text(
                    await session.call_tool(
                        "search_products", {"query": "headlamp", "filters": {"max_price": 600}}
                    )
                )
            )
            assert rows and rows[0]["product_id"] == HEADLAMP, rows
            assert not any("outside_price_filter" in r for r in rows), rows
            print(f"[5] 'headlamp' ≤600 -> {[r['product_id'] for r in rows]}, none marked")

            # The best match is in range: matches beyond the bound that rank below it are
            # not added (the espresso machine is a coffee maker over 600, ranked lower).
            rows = _results(
                _text(
                    await session.call_tool(
                        "search_products", {"query": "coffee maker", "filters": {"max_price": 600}}
                    )
                )
            )
            ids = [r["product_id"] for r in rows]
            assert ids[0] == DRIP_COFFEE and ESPRESSO not in ids, ids
            assert not any("outside_price_filter" in r for r in rows), rows
            print(f"[5b] 'coffee maker' ≤600 -> {ids}, none marked")

            # min_price is the same rule from below.
            rows = _results(
                _text(
                    await session.call_tool(
                        "search_products", {"query": "headlamp", "filters": {"min_price": 1000}}
                    )
                )
            )
            assert [r["product_id"] for r in rows] == [HEADLAMP], rows
            assert rows[0]["outside_price_filter"] == "below min_price 1000", rows
            print("[6] 'headlamp' ≥1000 -> headlamp marked 'below min_price 1000'")

            # No English word: the empty result says why, instead of "not carried".
            text = _text(await session.call_tool("search_products", {"query": "露营帐篷"}))
            assert (
                "no English words" in text and "says nothing about what the store carries" in text
            ), text
            print(f"[7] '露营帐篷' -> {text[:60]!r}…")

            # No price filter: CMA's own result, unchanged.
            text = _text(await session.call_tool("search_products", {"query": "tent"}))
            assert "outside_price_filter" not in text and BACKPACKING_TENT in text, text
            assert text.startswith(
                "Search returned 2 result(s): the catalog's closest text matches"
            ), text
            text = _text(await session.call_tool("search_products", {"query": "zzzz"}))
            assert text.startswith("Search returned 0 results: nothing in the catalog matched"), (
                text
            )
            print("[8] unbounded searches -> CMA's own headers (match and zero-result)")
    finally:
        shutil.rmtree(tmp, ignore_errors=True)
    print("\nALL CHECKS PASSED")


if __name__ == "__main__":
    asyncio.run(main())
