"""Offline smoke test for merchant_stdio_server, driven as a real MCP stdio client —
covers the full 22-tool surface, the
price guardrail rejecting an over-limit change at STAGE time (``ChangeLedger.stage()``
runs ``check_guardrails`` itself — see ``merchant_agent.changes``), apply_change held
while unapproved, and — the realistic, end-to-end flow — a change staged in one
process, approved on storefront-web's own operator store, and APPLIED
SUCCESSFULLY in a completely separate, later process. That last property needs
BOTH `MerchantSessionState` (provenance) AND `ChangeLedger` itself to survive a
process restart; both are now persisted to disk (`merchant.json` /
`merchant-ledger.json` — see `__main__.py`'s module docstring for the codec
`ChangeLedger` needed since it has no serialization of its own).

Two run modes:

    python runtime/tests/smoke_stdio.py
        Runs everything except the cross-process approve -> apply cycle (marked
        SKIPPED): with no BACKEND_BASE_URL, `_fetch_approved_ids` always returns
        empty (fail-closed default), so apply_change can never succeed in this
        mode — by design, not a gap (see __main__.py). Still checks that an
        unapproved change stays held after a process restart.

    STOREFRONT_WEB_URL=http://localhost:8000 python runtime/tests/smoke_stdio.py
        Also runs the full cross-process approve -> apply cycle against a real,
        running apps/storefront-web (contract b).

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

from mcp import ClientSession, StdioServerParameters
from mcp.client.stdio import stdio_client

EXPECTED_TOOLS = {
    "get_business_snapshot",
    "query_metrics",
    "get_campaign_performance",
    "search_listings",
    "get_listing",
    "get_inventory_alerts",
    "get_order_issues",
    "get_pricing_context",
    "get_pending_changes",
    "stage_listing_update",
    "stage_price_update",
    "stage_inventory_action",
    "stage_promotion",
    "stage_campaign",
    "apply_change",
    "discard_change",
    "save_memory",
    "recall_memories",
    "present_metrics",
    "present_digest",
    "present_change_preview",
    "present_suggestions",
}
assert len(EXPECTED_TOOLS) == 22


def _text(result) -> str:
    assert result.content, "tool result had no content blocks"
    block = result.content[0]
    assert block.type == "text", f"expected a text content block, got {block.type}"
    return block.text


def _fenced_json(text: str) -> object:
    """Parse the JSON body between ``<merchant_data>``/``</merchant_data>`` — some
    results (search_listings) prepend a plain-text header line before the fence
    (see ``merchant_agent.serialization.search_result_text``), so this looks for the
    tags rather than assuming a fixed line count."""
    start = text.index("<merchant_data>\n") + len("<merchant_data>\n")
    end = text.index("\n</merchant_data>")
    return json.loads(text[start:end])


@asynccontextmanager
async def _session(
    state_dir: Path,
    *,
    merchant_id: str = "acme-retail",
    operator: str = "operator-1",
    session_id: str = "merchant-sess-1",
    backend_base_url: str | None = None,
):
    env = {
        **os.environ,
        "CMA_STATE_DIR": str(state_dir),
        "CMA_MERCHANT_ID": merchant_id,
        "CMA_OPERATOR": operator,
        "CMA_CHAT_SESSION_ID": session_id,
    }
    if backend_base_url:
        env["BACKEND_BASE_URL"] = backend_base_url
    server = StdioServerParameters(command=sys.executable, args=["-m", "merchant_stdio_server"], env=env)
    async with stdio_client(server) as (read, write):
        async with ClientSession(read, write) as session:
            await session.initialize()
            yield session


async def main() -> None:
    storefront_web_url = os.environ.get("STOREFRONT_WEB_URL")
    backend_base_url = f"{storefront_web_url}/api" if storefront_web_url else None

    tmp = Path(tempfile.mkdtemp(prefix="cma-merchant-smoke-"))
    try:
        state_dir = tmp / "cma-state"
        async with _session(state_dir, backend_base_url=backend_base_url) as session:
            tools = (await session.list_tools()).tools
            names = {t.name for t in tools}
            assert names == EXPECTED_TOOLS, (
                f"tool surface mismatch.\n  missing: {EXPECTED_TOOLS - names}\n"
                f"  unexpected: {names - EXPECTED_TOOLS}"
            )
            print(f"[1] tools/list: exactly the {len(EXPECTED_TOOLS)} expected names")

            recall_desc = next(t for t in tools if t.name == "recall_memories").description
            assert "older or more specific" in recall_desc, (
                f"recall_memories is not using the inline-context description: {recall_desc!r}"
            )
            print("[1] recall_memories uses the inline-context description")

            snapshot = await session.call_tool("get_business_snapshot", {})
            assert not snapshot.isError, _text(snapshot)
            present = await session.call_tool(
                "present_metrics", {"picks": [{"metric": "revenue", "note": "smoke check"}]}
            )
            assert not present.isError, _text(present)
            envelope = json.loads(_text(present))
            assert envelope["displayed"] is True and envelope["component"] == "metrics", envelope
            assert "metrics" in envelope["payload"], envelope
            print(f"[D-R4] present_metrics -> mode-A envelope: {list(envelope.keys())}")

            search = await session.call_tool("search_listings", {"query": "tent"})
            assert not search.isError, _text(search)
            listing_line = _text(search)
            print(f"[2] search_listings('tent') -> {listing_line[:120]!r}...")

            # Pull a listing id out of the fenced JSON result rather than hardcoding one,
            # so this test does not silently stop covering the real gate the moment the
            # fixture catalog changes.
            listing_id = _fenced_json(listing_line)["results"][0]["listing_id"]

            details = await session.call_tool("get_listing", {"listing_id": listing_id})
            assert not details.isError, _text(details)
            pricing = await session.call_tool("get_pricing_context", {"listing_id": listing_id})
            assert not pricing.isError, _text(pricing)
            print(f"[2] get_listing/get_pricing_context({listing_id}) -> ok")

            current_price = _fenced_json(_text(details))["price"]
            pricing_ceiling = _fenced_json(_text(pricing)).get("max_price")
            # Over the default 20% max_price_delta_pct guardrail, but still under the
            # store's own absolute ceiling (get_pricing_context's max_price) — otherwise
            # staging itself would refuse for a DIFFERENT reason (refuse_outside_range)
            # and this would not isolate the guardrail-gate behavior being tested.
            new_price = round(current_price * 1.28, 2)
            if pricing_ceiling is not None:
                assert new_price <= pricing_ceiling, (
                    f"test fixture assumption broken: {new_price} exceeds this listing's own "
                    f"ceiling {pricing_ceiling} — pick a smaller over-guardrail multiplier"
                )

            over_guardrail_stage = await session.call_tool(
                "stage_price_update", {"items": [{"listing_id": listing_id, "new_price": new_price}]}
            )
            # ChangeLedger.stage() (merchant_agent.changes) runs check_guardrails itself
            # before ever creating a StagedChange, so an over-limit move is held at
            # STAGE time — a held call is `is_error=False` with no fence in its text (it
            # never became a StagedChange to fence), unlike a successful stage.
            assert not over_guardrail_stage.isError, "a held call is not an MCP error"
            held_text = _text(over_guardrail_stage)
            assert "guardrail" in held_text.lower() and "20%" in held_text, held_text
            print(f"[3] stage_price_update(+28%) -> held by the guardrail gate at STAGE time: {held_text!r}")

            # -- a compliant price change: stage, then confirm apply_change is held for
            # missing approval (require_host_approval defaults True).
            compliant_price = round(current_price * 1.05, 2)  # +5%, within guardrail
            stage2 = await session.call_tool(
                "stage_price_update",
                {"items": [{"listing_id": listing_id, "new_price": compliant_price}]},
            )
            assert not stage2.isError, _text(stage2)
            # This asserts the __main__.py fix directly: `stage_price_update` (config
            # default `stage_shows_preview=True`) ALSO produces a `ui` AgentEvent as a
            # side effect (the auto-rendered preview card) — regression-testing that
            # this stays a fenced "staged" JSON with the real change_id, not the D-R4
            # mode-A envelope of that side-effect preview (see PRESENTATION_TOOLS's
            # docstring in __main__.py for why those must not be conflated).
            assert _text(stage2).startswith("<merchant_data>\n"), (
                f"stage_price_update's own result was replaced by its side-effect "
                f"preview's D-R4 envelope: {_text(stage2)!r}"
            )
            change_id_2 = _fenced_json(_text(stage2))["staged"]["change_id"]

            unapproved_apply = await session.call_tool("apply_change", {"change_id": change_id_2})
            assert not unapproved_apply.isError, "a held call is not an MCP error"
            assert "approv" in _text(unapproved_apply).lower(), _text(unapproved_apply)
            print(f"[4] apply_change({change_id_2}), no approval -> held: {_text(unapproved_apply)!r}")

            # A THIRD change, staged and left UNAPPROVED — carried into a later, fresh
            # process purely to confirm it stays held there too (not auto-approved by
            # anything ChangeLedger persistence might have introduced).
            stage3 = await session.call_tool(
                "stage_price_update",
                {"items": [{"listing_id": listing_id, "new_price": round(current_price * 1.03, 2)}]},
            )
            assert not stage3.isError, _text(stage3)
            change_id_3 = _fenced_json(_text(stage3))["staged"]["change_id"]

        # -- approve change_id_2 on storefront-web's own store, exactly the way the
        # operator page does: fetch /changes/pending to find this change's mirror_key
        # (the store's own de-duplication key — NOT the bare change_id, which is only
        # unique within one ChangeLedger's lifetime; see changes-store.ts's module
        # docstring for the real bug this avoids), then POST .../approve with it.
        if storefront_web_url:
            import httpx

            async with httpx.AsyncClient(base_url=backend_base_url, timeout=10.0) as http:
                pending = await http.get("/changes/pending", params={"merchantId": "acme-retail"})
                pending.raise_for_status()
                row = next(c for c in pending.json()["changes"] if c["change_id"] == change_id_2)
                approve = await http.post(f"/changes/{row['mirror_key']}/approve")
                approve.raise_for_status()
                print(f"[4] POST /changes/.../approve ({change_id_2}) on storefront-web -> {approve.json()['change']['approved']}")

            # -- THE central M3 check: a BRAND NEW process, same state dir, applies the
            # NOW-APPROVED change_id_2 and it actually SUCCEEDS. This requires THREE
            # things to all be true at once: MerchantSessionState survived (provenance),
            # ChangeLedger survived (merchant-ledger.json — without this, apply would
            # fail with "no change with id ... to apply" even once approved, since
            # ChangeLedger.apply() needs the change to still exist in ITS OWN records),
            # and the fresh fetch to storefront-web's approved-ids picks up the approval.
            async with _session(state_dir, backend_base_url=backend_base_url) as session:
                approved_apply = await session.call_tool("apply_change", {"change_id": change_id_2})
                assert not approved_apply.isError, _text(approved_apply)
                assert "operator-1" in _text(approved_apply), _text(approved_apply)
                print(f"[5] FRESH PROCESS apply_change({change_id_2}) after storefront-web approval -> {_text(approved_apply)!r}")

            # -- the negative control, in ANOTHER fresh process: change_id_3 was staged
            # but never approved, so it must still be held — not applied (proving
            # ledger persistence alone does not bypass the approval gate) and not
            # "no such change" (proving the ledger really did load change_id_3, not
            # just change_id_2 coincidentally left over from an in-memory instance).
            async with _session(state_dir, backend_base_url=backend_base_url) as session:
                still_held = await session.call_tool("apply_change", {"change_id": change_id_3})
                assert not still_held.isError, _text(still_held)
                assert "approv" in _text(still_held).lower(), _text(still_held)
                assert "no change with id" not in _text(still_held).lower(), (
                    f"ChangeLedger did not actually persist change_id_3: {_text(still_held)!r}"
                )
                print(f"[5] FRESH PROCESS apply_change({change_id_3}), still unapproved -> held: {_text(still_held)!r}")
        else:
            print("[4]/[5] cross-process approve -> apply cycle SKIPPED (no STOREFRONT_WEB_URL)")
            async with _session(state_dir, backend_base_url=backend_base_url) as session:
                reuse = await session.call_tool("apply_change", {"change_id": change_id_3})
                assert not reuse.isError
                assert "was not staged or listed" not in _text(reuse), (
                    f"MerchantSessionState did not survive the process restart: {_text(reuse)!r}"
                )
                assert "approv" in _text(reuse).lower(), _text(reuse)
                print(f"[5] fresh process, same state dir -> change_id provenance survived: {_text(reuse)!r}")

        # -- runs in BOTH modes: `read_listings` is a plain `set[str]` field on
        # MerchantSessionState, separate from `seen_listings` (a dict) and
        # `approved_change_ids` (a set this file deliberately does NOT persist — see
        # __main__.py). Verify its round-trip explicitly rather than assuming
        # pydantic v2 restores a `set` from the JSON array `model_dump_json` writes:
        # stage_listing_update's check_listing_record_read gate reads it, and a
        # silently-lost set would fail closed here in a way that looks identical to
        # "never called get_listing" rather than "read_listings didn't survive
        # serialization".
        async with _session(state_dir, backend_base_url=backend_base_url) as session:
            content_edit = await session.call_tool(
                "stage_listing_update",
                {"listing_id": listing_id, "fields": {"short_description": "Smoke-tested description."}},
            )
            assert not content_edit.isError, _text(content_edit)
            assert "needs the full record" not in _text(content_edit), (
                f"read_listings did not survive the process restart (model_dump_json "
                f"round-trip of a set[str] field): {_text(content_edit)!r}"
            )
            print(f"[5] fresh process, same state dir -> read_listings survived: {_text(content_edit)[:120]!r}")

    finally:
        shutil.rmtree(tmp, ignore_errors=True)

    print("\nALL CHECKS PASSED")


if __name__ == "__main__":
    asyncio.run(main())
