"""M2's end-to-end offline check (reproduction plan §6 contracts a/c/d): the stdio
server's HTTP `StorefrontBackend`/`MemoryStore` adapters and `CMA_UI_DELIVERY=
backend_post` against a REAL `apps/storefront-web` process — not mocked, not
in-process. This is the single check that exercises adapter (de)serialization,
error-code mapping, and the ui-events POST together; `smoke_stdio.py` already covers
the embedded-MockRetail path (M1) and is not repeated here.

Prerequisite: `apps/storefront-web` built and running (`pnpm turbo build && pnpm
start`, port 8000 by default). Run:

    STOREFRONT_WEB_URL=http://localhost:8000 python runtime/tests/smoke_http_backend.py

Exits 0 and prints "ALL CHECKS PASSED" on success; raises on the first failed
assertion.
"""

from __future__ import annotations

import asyncio
import json
import os
import shutil
import sys
import tempfile
from contextlib import asynccontextmanager
from pathlib import Path

import httpx
from mcp import ClientSession, StdioServerParameters
from mcp.client.stdio import stdio_client

BACKEND_BASE_URL = os.environ.get("STOREFRONT_WEB_URL", "http://localhost:8000") + "/api"

TENT_ID = "AR-1201"  # in stock, $149
OUT_OF_STOCK_ID = "AR-1002"  # ACME Signature 15-Bar Espresso Machine — out_of_stock: false in fixtures


def _text(result) -> str:
    assert result.content, "tool result had no content blocks"
    block = result.content[0]
    assert block.type == "text", f"expected a text content block, got {block.type}"
    return block.text


@asynccontextmanager
async def _session(
    state_dir: Path,
    *,
    user_id: str = "demo-user",
    session_id: str = "sess-http-1",
    ui_delivery: str | None = None,
):
    env = {
        **os.environ,
        "CMA_STATE_DIR": str(state_dir),
        "CMA_END_USER_ID": user_id,
        "CMA_CHAT_SESSION_ID": session_id,
        "BACKEND_BASE_URL": BACKEND_BASE_URL,
    }
    if ui_delivery:
        env["CMA_UI_DELIVERY"] = ui_delivery
    server = StdioServerParameters(command=sys.executable, args=["-m", "storefront_stdio_server"], env=env)
    async with stdio_client(server) as (read, write):
        async with ClientSession(read, write) as session:
            await session.initialize()
            yield session


async def main() -> None:
    tmp = Path(tempfile.mkdtemp(prefix="cma-http-smoke-"))
    try:
        state_dir_a = tmp / "cma-state-a"

        # -- process 1 (user "http-user-1"): search seeds provenance for both ids,
        # add the in-stock one, then add the out-of-stock one and check the HTTP
        # backend's 409 comes back through as CMA's own Unavailable/"sold out" text.
        async with _session(state_dir_a, user_id="http-user-1") as session:
            search = await session.call_tool("search_products", {"query": "tent"})
            assert not search.isError and TENT_ID in _text(search)
            print(f"[1] search_products via HTTP backend -> {TENT_ID} present")

            details = await session.call_tool("get_product_details", {"product_id": OUT_OF_STOCK_ID})
            assert not details.isError, _text(details)

            add = await session.call_tool("add_to_cart", {"product_id": TENT_ID, "quantity": 1})
            assert not add.isError, _text(add)
            assert f"Added {TENT_ID}" in _text(add), _text(add)
            print(f"[1] add_to_cart({TENT_ID}) via HTTP backend -> {_text(add)!r}")

            sold_out = await session.call_tool("add_to_cart", {"product_id": OUT_OF_STOCK_ID, "quantity": 1})
            assert sold_out.isError, "an Unavailable backend response must surface as a tool error"
            assert "Nothing was added" in _text(sold_out) and "out of stock" in _text(sold_out), _text(
                sold_out
            )
            print(f"[2] add_to_cart({OUT_OF_STOCK_ID}) -> HTTP 409 mapped to Unavailable -> {_text(sold_out)!r}")

            save = await session.call_tool(
                "save_memory",
                {"key": "trip", "value": "planning a backpacking trip", "category": "context"},
            )
            assert not save.isError
            print(f"[3] save_memory via HTTP memory store -> {_text(save)!r}")

        # -- process 2, SAME user, DIFFERENT (fresh) state dir: the cart must have
        # survived via the HTTP backend even though local on-disk state did not carry
        # over — proving persistence moved server-side, not just process-to-process
        # via the shared state_dir the way M1's provenance test relies on.
        state_dir_b = tmp / "cma-state-b"
        async with _session(state_dir_b, user_id="http-user-1") as session:
            cart = await session.call_tool("get_cart", {})
            assert not cart.isError
            assert TENT_ID in _text(cart), (
                f"cart did not survive a fresh state dir + fresh process for the same user "
                f"— HTTP backend persistence did not work: {_text(cart)!r}"
            )
            print(f"[4] fresh process + fresh state dir, same user -> cart still has {TENT_ID} (HTTP backend persisted it)")

            recall = await session.call_tool("recall_memories", {"topic": "trip"})
            assert not recall.isError
            assert "backpacking trip" in _text(recall), _text(recall)
            print("[4] fresh process + fresh state dir, same user -> recall_memories finds it (HTTP memory store persisted it)")

        # -- distinct user: a cart written by "http-user-1" must not leak to
        # "http-user-2" (X-CMA-User is the only signal the backend has).
        state_dir_c = tmp / "cma-state-c"
        async with _session(state_dir_c, user_id="http-user-2") as session:
            cart = await session.call_tool("get_cart", {})
            assert not cart.isError
            assert TENT_ID not in _text(cart), f"cart leaked across X-CMA-User identities: {_text(cart)!r}"
            print("[5] distinct X-CMA-User -> distinct (empty) cart")

        # -- CMA_UI_DELIVERY=backend_post: present_products' own MCP result must stay
        # CMA's plain confirmation (not the JSON envelope), and the payload must
        # actually land in storefront-web's ui-events queue under this session id.
        state_dir_d = tmp / "cma-state-d"
        ui_session_id = "sess-http-ui-events"
        async with _session(
            state_dir_d, user_id="http-user-3", session_id=ui_session_id, ui_delivery="backend_post"
        ) as session:
            search = await session.call_tool("search_products", {"query": "tent"})
            assert not search.isError
            present = await session.call_tool(
                "present_products",
                {"picks": [{"product_id": TENT_ID, "reason": "matches the ask"}]},
            )
            assert not present.isError, _text(present)
            assert _text(present) == "Displayed to the customer.", (
                f"backend_post mode must leave the tool result as CMA's plain confirmation, got: {_text(present)!r}"
            )
            print(f"[6] backend_post mode -> tool result unchanged: {_text(present)!r}")

        async with httpx.AsyncClient(base_url=BACKEND_BASE_URL, timeout=10.0) as http:
            polled = await http.get("/agent/ui-events", params={"sessionId": ui_session_id, "since": 0})
            polled.raise_for_status()
            events = polled.json()["events"]
            assert len(events) == 1, f"expected exactly one ui-event, got {events}"
            assert events[0]["component"] == "products", events[0]
            assert events[0]["payload"]["items"][0]["product"]["product_id"] == TENT_ID, events[0]
            print(f"[6] backend_post mode -> storefront-web's ui-events queue received it: {events[0]['component']!r}")

    finally:
        shutil.rmtree(tmp, ignore_errors=True)

    print("\nALL CHECKS PASSED")


if __name__ == "__main__":
    asyncio.run(main())
