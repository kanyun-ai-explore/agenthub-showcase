"""Offline smoke test for storefront_stdio_server, driven as a real MCP stdio
client (not an in-process import) — covers M1 acceptance criteria ①②④ and part
of the acceptance list without any AgentHub sandbox or Claude Code CLI.

Not wired into any test runner (no pytest fixture, no CI job) — this package is
vendored to be pip-installed in a sandbox, not to carry its own CI. Run manually
against a venv that has `mcp` + this package's own 3 local packages installed:

    python runtime/tests/smoke_stdio.py

Exits 0 and prints "ALL CHECKS PASSED" on success; raises (with a clear message)
and exits non-zero on the first failed assertion.
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

from mcp import ClientSession, StdioServerParameters
from mcp.client.stdio import stdio_client

# The registry's full tool surface minus load_skill (Claude Code's native Skill tool
# replaces it), with disclosures off (this package's agent.yaml default) — reproduction
# plan §4.3's 20-name list.
EXPECTED_TOOLS = {
    "search_products",
    "get_product_details",
    "get_cart",
    "add_to_cart",
    "update_cart_item",
    "remove_from_cart",
    "get_preferences",
    "get_orders",
    "get_order_status",
    "search_policies",
    "get_fulfillment_options",
    "save_memory",
    "recall_memories",
    "present_products",
    "present_comparison",
    "present_plan",
    "present_guide",
    "present_order_status",
    "checkout",
    "present_suggestions",
}

TENT_ID = "AR-1201"  # "ACME Basecamp 2-Person Backpacking Tent", $149 — the exact
# scenario M1 acceptance criterion ① names ("两人帐篷 400 以内").
UNSEEN_ID = "ZZ-0000-DOES-NOT-EXIST"


def _text(result) -> str:
    assert result.content, "tool result had no content blocks"
    block = result.content[0]
    assert block.type == "text", f"expected a text content block, got {block.type}"
    return block.text


@asynccontextmanager
async def _session(state_dir: Path, *, user_id: str = "demo-user", session_id: str = "sess-1"):
    server = StdioServerParameters(
        command=sys.executable,
        args=["-m", "storefront_stdio_server"],
        env={
            **os.environ,
            "CMA_STATE_DIR": str(state_dir),
            "CMA_END_USER_ID": user_id,
            "CMA_CHAT_SESSION_ID": session_id,
        },
    )
    async with stdio_client(server) as (read, write):
        async with ClientSession(read, write) as session:
            await session.initialize()
            yield session


async def main() -> None:
    tmp = Path(tempfile.mkdtemp(prefix="cma-smoke-"))
    state_dir = tmp / "cma-state"
    try:
        # -- process 1: tools/list shape, search -> details -> add_to_cart, present,
        #    save_memory. Everything in one process/session (M1 ①②⑤, most of ③).
        async with _session(state_dir) as session:
            tools = (await session.list_tools()).tools
            names = {t.name for t in tools}
            assert names == EXPECTED_TOOLS, (
                f"tool surface mismatch.\n  missing: {EXPECTED_TOOLS - names}\n"
                f"  unexpected: {names - EXPECTED_TOOLS}"
            )
            print(f"[1] tools/list: exactly the {len(EXPECTED_TOOLS)} expected names")

            # INLINE_CONTEXT_DESCRIPTIONS fidelity: get_preferences must carry the
            # inline variant (no per-request Session context block on this path).
            get_prefs = next(t for t in tools if t.name == "get_preferences")
            assert "remembered facts from past conversations" in get_prefs.description, (
                f"get_preferences description is not the inline-context variant: "
                f"{get_prefs.description!r}"
            )
            assert "status" not in get_prefs.inputSchema.get("properties", {}), (
                "published_schema() should have dropped the 'status' property"
            )
            search_schema = next(t for t in tools if t.name == "search_products").inputSchema
            assert "status" not in search_schema.get("properties", {}), (
                "published_schema() drops 'status' for every tool on the MCP path "
                "(capability matrix #9), not just presentation tools"
            )
            print("[1] get_preferences uses the inline-context description; 'status' dropped everywhere (MCP path)")

            search_result = await session.call_tool("search_products", {"query": "tent"})
            assert not search_result.isError
            assert TENT_ID in _text(search_result), f"{TENT_ID} not in search results"
            print(f"[2] search_products('tent') -> {TENT_ID} present")

            details_result = await session.call_tool(
                "get_product_details", {"product_id": TENT_ID}
            )
            assert not details_result.isError
            print("[2] get_product_details -> ok")

            add_result = await session.call_tool(
                "add_to_cart", {"product_id": TENT_ID, "quantity": 1}
            )
            assert not add_result.isError, _text(add_result)
            assert f"Added {TENT_ID}" in _text(add_result), _text(add_result)
            print(f"[2] add_to_cart({TENT_ID}) -> {_text(add_result)!r}")

            present_result = await session.call_tool(
                "present_products",
                {"picks": [{"product_id": TENT_ID, "reason": "matches the two-person, under-$400 ask"}]},
            )
            assert not present_result.isError
            envelope = json.loads(_text(present_result))
            assert envelope["displayed"] is True
            assert envelope["component"] == "products"
            assert envelope["payload"]["items"][0]["product"]["product_id"] == TENT_ID
            print(f"[4] present_products -> result_text envelope: {envelope.keys()}")

            policy_result = await session.call_tool("search_policies", {"query": "returns"})
            assert not policy_result.isError
            assert "return" in _text(policy_result).lower(), _text(policy_result)
            print("[5-policy] search_policies('returns') -> ok, fenced result mentions returns")

            unseen_present = await session.call_tool(
                "present_products", {"picks": [{"product_id": UNSEEN_ID}]}
            )
            # A fully-refused presentation call (no items resolved) is a held/refused
            # outcome with NO ui event, so it must NOT be JSON-wrapped — the gate text
            # passes through unwrapped, same as a domain-tool held call.
            assert not unseen_present.isError
            refused_text = _text(unseen_present)
            assert "provenance" not in refused_text.lower() or "session" in refused_text.lower()
            try:
                json.loads(refused_text)
            except json.JSONDecodeError:
                pass
            else:
                raise AssertionError(
                    "a refused present_products call must not be JSON-enveloped: "
                    f"{refused_text!r}"
                )
            print(f"[4] present_products with an unseen id -> refused, unwrapped: {refused_text!r}")

            save_result = await session.call_tool(
                "save_memory",
                {"key": "activity", "value": "customer shops for backpacking gear", "category": "preference"},
            )
            assert not save_result.isError
            print(f"[1] save_memory -> {_text(save_result)!r}")

            # -- concurrency: 5 search_products + 1 save_memory as genuinely concurrent
            # in-flight MCP requests on one connection (asyncio.gather, not sequential
            # awaits). Every call must succeed, the state file must parse afterward, and
            # no _persist_state .tmp file may be left behind.
            concurrent_calls = [
                session.call_tool("search_products", {"query": f"tent {i}"}) for i in range(5)
            ]
            concurrent_calls.append(
                session.call_tool(
                    "save_memory",
                    {"key": "concurrent_check", "value": "fired during concurrent burst", "category": "context"},
                )
            )
            concurrent_results = await asyncio.gather(*concurrent_calls)
            assert all(not r.isError for r in concurrent_results), [
                _text(r) for r in concurrent_results if r.isError
            ]
            state_path = state_dir / "shopping-state.json"
            assert state_path.exists(), "state file missing after concurrent burst"
            json.loads(state_path.read_text(encoding="utf-8"))  # must parse — not half-written
            leftover_tmp = list(state_dir.glob(f"{state_path.name}.*"))
            assert not leftover_tmp, f"leftover tmp files after concurrent burst: {leftover_tmp}"
            print(
                f"[concurrency] 6 concurrent calls (5x search_products + save_memory) -> "
                f"all ok, state file parses, no .tmp leftovers"
            )

        # -- process 2 (fresh subprocess, same CMA_STATE_DIR + session id = next turn
        #    of the same AgentHub session): provenance and memory must survive the
        #    process boundary; add_to_cart on a genuinely never-seen id must be held.
        async with _session(state_dir) as session:
            reuse_result = await session.call_tool(
                "add_to_cart", {"product_id": TENT_ID, "quantity": 1}
            )
            assert not reuse_result.isError, (
                f"provenance did not survive a process restart: {_text(reuse_result)}"
            )
            print(f"[5] new process, add_to_cart on turn-1's product_id -> {_text(reuse_result)!r}")

            recall_result = await session.call_tool("recall_memories", {"topic": "activity"})
            assert not recall_result.isError
            assert "backpacking gear" in _text(recall_result), _text(recall_result)
            print("[5] new process, recall_memories -> finds turn-1's saved fact")

            held_result = await session.call_tool(
                "add_to_cart", {"product_id": UNSEEN_ID, "quantity": 1}
            )
            assert not held_result.isError, "a held call is not an MCP error"
            held_text = _text(held_result)
            assert "was not returned by catalog or order tools in this session" in held_text
            print(f"[3] new process, add_to_cart on a never-seen id -> held: {held_text!r}")

        # -- negative control: fresh state dir, fresh process — the SAME product_id
        #    that succeeded above must be held here, proving [5] wasn't a false
        #    positive from some other bypass (e.g. a shared in-memory cache).
        fresh_state_dir = tmp / "cma-state-fresh"
        async with _session(fresh_state_dir) as session:
            control_result = await session.call_tool(
                "add_to_cart", {"product_id": TENT_ID, "quantity": 1}
            )
            assert not control_result.isError, "a held call is not an MCP error"
            assert "was not returned by catalog or order tools" in _text(control_result)
            print("[control] fresh state dir, same product_id -> held (as expected)")

        # Known, documented limitation (not asserted as passing): MockRetail's cart is
        # in-memory (SessionCarts) with no disk persistence, so a cart write does NOT
        # survive a process restart today — only provenance and memory do. See
        # storefront_stdio_server/__main__.py::_build_backend's docstring and

    finally:
        shutil.rmtree(tmp, ignore_errors=True)

    print("\nALL CHECKS PASSED")


if __name__ == "__main__":
    asyncio.run(main())
