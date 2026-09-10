"""The merchant stdio MCP server: CMA's merchant-agent tool registry and
``MerchantToolExecutor`` (both unmodified upstream code — see repo root NOTICE),
served over stdio to one Claude Code CLI process per AgentHub session. Structured the
same way as ``cma-shopping``'s ``storefront_stdio_server`` (same low-level
``mcp.server.Server`` reasoning — see that module's docstring, unchanged here) with one
new piece that has no shopping-side equivalent: the approval gate.

**Approval across a process boundary (D-R6 / reproduction plan §6 contract b).** CMA's
own reference host runs `require_host_approval` in one process: a portal button
handler mutates ``MerchantSessionState.approved_change_ids`` in memory, microseconds
before the same process dispatches ``apply_change``. That does not work here —
``apps/storefront-web`` (the operator's approval page) and this stdio server are
different processes, and this process restarts every turn (D-R2) besides. So the
approval mark itself moves to ``apps/storefront-web``'s own store
(``lib/backend/changes-store.ts``), and this server:

1. mirrors every staged change there right after a successful stage/apply/discard call
   (``_mirror_changes``), so the operator page has something to approve; and
2. re-fetches the CURRENT approved set from there immediately before dispatching
   ``apply_change`` (``_fetch_approved_ids``) — never cached from a prior call, and
   populated fresh into ``state.approved_change_ids`` for
   ``merchant_agent.gates.check_apply_change`` to read the way it always has.

Fail-closed, deliberately: a fetch failure leaves the approved set EMPTY for that
call, not whatever it held before. ``approved_change_ids`` is the one field in
``MerchantSessionState`` where "unknown" and "not approved" must be the same answer —
see ``_persist_state``'s docstring for why it is also never written to disk.

**``ChangeLedger`` persists too (D-R2), not just ``MerchantSessionState``.**
``MockRetailMerchant`` (the embedded backend) owns one ``ChangeLedger`` per
process; without persisting it, a change staged in turn N would not exist for
turn N+1's fresh process to apply, no matter how correctly the approval mark
above was synced. ``_dump_ledger``/``_restore_ledger`` are a small JSON codec
against ``ChangeLedger``'s two internal fields (``_changes``, ``_sequence`` — it
has no serialization of its own) written at the server layer, not by editing CMA's
source, same boundary the HTTP adapters keep elsewhere in this repo. Loaded into a
freshly-constructed ``ChangeLedger`` at startup, persisted (same atomic
tempfile+``os.replace`` pattern as ``_persist_state``) after every successful
stage/apply/discard call.
"""

from __future__ import annotations

import json
import logging
import os
import sys
import tempfile
from contextlib import suppress
from pathlib import Path
from typing import Any

import anyio
import httpx
import mcp.types as types
from commerce_common.execution import LOAD_SKILL, contracts_by_name
from commerce_common.mcp_server import published_schema
from commerce_common.memory import JsonFileMemoryStore
from commerce_common.skills import SkillRegistry
from commerce_common.streaming import ToolOutcome
from mcp.server.lowlevel import Server
from mcp.server.stdio import stdio_server
from merchant_agent import (
    MerchantAgentConfig,
    MerchantSessionContext,
    MerchantSessionState,
    StagedChange,
)
from merchant_agent.executor import MerchantToolExecutor, build_memory
from merchant_agent.tools.registry import INLINE_CONTEXT_DESCRIPTIONS, build_tools

logger = logging.getLogger("merchant_stdio_server")

SERVER_NAME = "merchant"
SERVER_INSTRUCTIONS = (
    "Merchant portal tools: performance metrics, catalog listings, inventory and order "
    "health, pricing, and staged changes (price, inventory, promotion, campaign, listing "
    "content). Every write is staged, not applied — apply_change only succeeds once an "
    "operator approves it on the portal's own approval page; nothing here places a "
    "customer order or touches storefront cash directly."
)

STATE_DIR = Path(os.environ.get("CMA_STATE_DIR", "/workspace/.session/cma-state"))
STATE_FILE = STATE_DIR / "merchant.json"  # MerchantSessionState (provenance)
MEMORY_FILE = STATE_DIR / "merchant-memory.json"
LEDGER_FILE = STATE_DIR / "merchant-ledger.json"  # ChangeLedger — see module docstring

# Write tools (mirrors 1:1 to `MerchantBackend`'s "Staged writes" section): every one of
# these gets `agent.yaml`'s `approvalPolicy: always_ask` declaration (see that file's
# comment for the current stdio-registration constraint on that declaration).
CHANGE_MUTATING_TOOLS = frozenset(
    {
        "stage_listing_update",
        "stage_price_update",
        "stage_inventory_action",
        "stage_promotion",
        "stage_campaign",
        "apply_change",
        "discard_change",
    }
)

# D-R4 envelope-wrapping applies ONLY to these — true presentation calls whose entire
# result IS the card. A stage_* call with `stage_shows_preview=True` ALSO produces a
# `ui` AgentEvent (its handler calls `_present` internally to auto-render the preview
# card), but its own `result_text` is the informative "staged": {change_id, ...} JSON
# the model needs to read back — not a bare confirmation the way present_* tools'
# is. Treating that `ui` event the same way would silently replace the change_id
# payload with the preview card's, which is a correctness bug, not a style choice.
# Known, documented scope boundary (not a silent gap): with `stage_shows_preview=True`,
# that auto-rendered preview's payload is therefore NOT delivered to any UI channel by
# this stdio server unless the model separately calls `present_change_preview` itself
#
PRESENTATION_TOOLS = frozenset(
    {"present_metrics", "present_digest", "present_change_preview", "present_suggestions"}
)


def _bool_env(name: str, default: bool) -> bool:
    raw = os.environ.get(name)
    if raw is None:
        return default
    return raw.strip().lower() not in ("0", "false", "no", "")


def _build_config() -> MerchantAgentConfig:
    return MerchantAgentConfig(
        brand_name=os.environ.get("CMA_BRAND_NAME", "the store"),
        assistant_name=os.environ.get("CMA_ASSISTANT_NAME", "the merchant assistant"),
        # Names, in the held-for-approval message the model reads (gates.py's
        # check_apply_change) and in CLAUDE.md, wherever CMA's own reference names
        # "the preview card's approval prompt" — this deployment's approval surface is
        # a separate page (apps/storefront-web's /operator), not an in-chat card, so
        # the string must say that instead. Keep this in sync with CLAUDE.md's own
        # occurrences (derived by runtime/scripts/derive-claude-md.py) and with
        # agent.yaml's env — the same brand_name-consistency discipline cma-shopping's
        # CLAUDE.md follows.
        approval_surface=os.environ.get(
            "CMA_APPROVAL_SURFACE", "the operator portal's approval page"
        ),
        enable_listing_edits=_bool_env("CMA_ENABLE_LISTING_EDITS", True),
        enable_inventory=_bool_env("CMA_ENABLE_INVENTORY", True),
        enable_pricing=_bool_env("CMA_ENABLE_PRICING", True),
        enable_campaigns=_bool_env("CMA_ENABLE_CAMPAIGNS", True),
        # stage_shows_preview: left at the class default (True), NOT overridden to
        # False the way CMA's own reference demo does. That demo's False assumes a
        # platform confirmation dialog (its agent.yaml marks apply_change
        # always_ask) doubling as the approval surface; this deployment has no such
        # dialog, so turning previews off here would mean a staged change is
        # genuinely never shown to the model or the operator until it happens to be
        # approved. Keep the model-side preview.
        # The SQL analysis delegate (D-R6's "L2" gateway-hosted remote-MCP mechanism)
        # is out of scope for this showcase — see the ratification note's
        # subagent-deferral decision. The CLI-native analyst subagent
        # (.claude/agents/analyst.md) is a read-only, whitelist-only tool user with no
        # SQL access of its own; it does not go through this switch at all.
        enable_analysis=False,
    )


def _build_session() -> MerchantSessionContext:
    """D-R3 merchant identity: ``CMA_MERCHANT_ID``/``CMA_OPERATOR`` (the shopping-side
    equivalents are ``CMA_END_USER_ID``/implicit) travel in session ``configValues`` ->
    CLI env -> here. Default ``merchant_id`` matches ``MockRetailMerchant``'s own
    default so the embedded backend and the approval-mirror's ``merchantId`` scope
    agree without any extra configuration."""
    return MerchantSessionContext(
        session_id=os.environ.get("CMA_CHAT_SESSION_ID", "local-session"),
        merchant_id=os.environ.get("CMA_MERCHANT_ID", "acme-retail"),
        operator=os.environ.get("CMA_OPERATOR", "demo-operator"),
        timezone=os.environ.get("CMA_TIMEZONE") or None,
    )


def _build_backend(config: MerchantAgentConfig, merchant_id: str):
    """CMA's own reference ``MockRetailMerchant`` wraps a ``MockRetail`` instance (it
    reads the same catalog to derive listings) and owns its ``ChangeLedger``
    in-process — see that class's docstring in
    ``_examples/retail/api/mock_merchant.py`` for why a real ``MerchantBackend``
    cannot be swapped in independently of a ``StorefrontBackend`` the way contract
    (a) does for shopping. Building an HTTP `MerchantBackend` (metrics/listings/
    inventory/pricing over the wire, contract-a style) was not asked for by this
    milestone and is not implemented; only the approval mark (contract b) crosses
    into HTTP — see the module docstring. The freshly-constructed ``ChangeLedger``
    is immediately overwritten with whatever ``_load_ledger_into`` finds on disk —
    see the module docstring's "ChangeLedger persists too" note.
    """
    examples_dir = Path(__file__).resolve().parent / "_examples"
    if str(examples_dir) not in sys.path:
        sys.path.insert(0, str(examples_dir))
    from retail.api.mock_merchant import MockRetailMerchant  # noqa: PLC0415
    from retail.api.mock_retail import MockRetail  # noqa: PLC0415

    storefront = MockRetail()
    backend = MockRetailMerchant(storefront=storefront, config=config, merchant_id=merchant_id)
    _load_ledger_into(backend.ledger)
    return backend


def _dump_ledger(ledger: Any) -> dict[str, Any]:
    """Serialize a ``ChangeLedger``'s state to a JSON-safe dict. ``ChangeLedger`` has
    no serialization of its own (a reasonable gap in an in-memory reference class),
    so this reaches its ``_changes``/``_sequence`` attributes directly rather than
    adding one to CMA's own source — the same "adapt at the server layer, never
    touch upstream" boundary the HTTP adapters keep elsewhere in this repo. If a
    future upstream version renames these two attributes this raises
    ``AttributeError`` loudly rather than silently losing data — an acceptable
    trade for a two-field, directly-observed internal shape verified against the
    installed vendored copy (``_examples/retail/api/mock_merchant.py``)."""
    return {
        "sequence": ledger._sequence,
        "changes": {
            change_id: change.model_dump(mode="json") for change_id, change in ledger._changes.items()
        },
    }


def _restore_ledger(ledger: Any, data: dict[str, Any]) -> None:
    """The inverse of ``_dump_ledger`` — mutates ``ledger`` (already constructed by
    ``MockRetailMerchant.__init__``) in place, replacing its freshly-empty state
    with what was persisted."""
    ledger._sequence = int(data.get("sequence", 0))
    ledger._changes = {
        change_id: StagedChange.model_validate(raw) for change_id, raw in data.get("changes", {}).items()
    }


def _load_ledger_into(ledger: Any) -> None:
    if not LEDGER_FILE.exists():
        return
    try:
        _restore_ledger(ledger, json.loads(LEDGER_FILE.read_text(encoding="utf-8")))
    except Exception:
        logger.warning(
            "failed to load %s; starting with an empty ChangeLedger", LEDGER_FILE, exc_info=True
        )


def _persist_ledger(ledger: Any) -> None:
    """Same atomic write-then-rename pattern as ``_persist_state`` (unique tmp name
    per call via ``tempfile.mkstemp`` — see that function's docstring for the
    concurrency reasoning, unchanged here)."""
    STATE_DIR.mkdir(parents=True, exist_ok=True)
    payload = json.dumps(_dump_ledger(ledger))
    fd, tmp_name = tempfile.mkstemp(dir=STATE_DIR, prefix=f"{LEDGER_FILE.name}.")
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            f.write(payload)
        os.replace(tmp_name, LEDGER_FILE)
    except BaseException:
        with suppress(OSError):
            os.unlink(tmp_name)
        raise


def _load_state() -> MerchantSessionState:
    if STATE_FILE.exists():
        try:
            state = MerchantSessionState.model_validate_json(STATE_FILE.read_text(encoding="utf-8"))
        except Exception:
            logger.warning(
                "failed to load %s; starting with empty session state", STATE_FILE, exc_info=True
            )
            state = MerchantSessionState()
    else:
        state = MerchantSessionState()
    # Never trust a disk-persisted approval mark — see the module docstring and
    # `_fetch_approved_ids`: this field is re-fetched fresh before every apply_change
    # dispatch and is never the source of truth on disk.
    state.approved_change_ids = set()
    return state


def _persist_state(state: MerchantSessionState) -> None:
    """Same atomic write-then-rename pattern as ``cma-shopping``'s
    ``_persist_state`` (``tempfile.mkstemp`` + ``os.replace``, unique tmp name per
    call — see that module's docstring for the concurrency reasoning, unchanged
    here). ``approved_change_ids`` is excluded: persisting an approval mark would
    make a stale disk value indistinguishable from a real one, which is exactly the
    failure mode the fresh-fetch-before-apply design exists to avoid."""
    STATE_DIR.mkdir(parents=True, exist_ok=True)
    payload = state.model_dump_json(exclude={"approved_change_ids"})
    fd, tmp_name = tempfile.mkstemp(dir=STATE_DIR, prefix=f"{STATE_FILE.name}.")
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            f.write(payload)
        os.replace(tmp_name, STATE_FILE)
    except BaseException:
        with suppress(OSError):
            os.unlink(tmp_name)
        raise


def _tool_contracts(config: MerchantAgentConfig) -> dict[str, Any]:
    contracts = contracts_by_name(build_tools(config, skill_names=[]))
    for name, description in INLINE_CONTEXT_DESCRIPTIONS.items():
        if name in contracts:
            contracts[name] = {**contracts[name], "description": description}
    contracts.pop(LOAD_SKILL, None)
    return contracts


_backend_post_unconfigured_warned = False


async def _post_ui_event(
    http_client: httpx.AsyncClient | None,
    *,
    chat_session_id: str,
    component: str,
    payload: Any,
) -> None:
    """D-R4 mode B — identical contract to cma-shopping's ``_post_ui_event`` (same
    endpoint, same header, same fail-silently discipline): a UI delivery hiccup must
    never turn an otherwise-successful presentation call into a failed one."""
    global _backend_post_unconfigured_warned
    if http_client is None:
        if not _backend_post_unconfigured_warned:
            logger.warning(
                "CMA_UI_DELIVERY=backend_post is set but BACKEND_BASE_URL is not; the "
                "%s payload was NOT posted anywhere.",
                component,
            )
            _backend_post_unconfigured_warned = True
        return
    try:
        response = await http_client.post(
            "/agent/ui-events",
            json={"component": component, "payload": payload},
            headers={"X-CMA-Chat-Session-Id": chat_session_id},
        )
        response.raise_for_status()
    except Exception:
        logger.warning(
            "failed to POST ui-event for %s; the tool result to the model is unaffected",
            component,
            exc_info=True,
        )


async def _fetch_approved_ids(
    http_client: httpx.AsyncClient | None, merchant_id: str
) -> set[str]:
    """Fail-closed: any error (network, non-2xx, bad body) returns an empty set, never
    raises and never returns a stale/cached value — see the module docstring."""
    if http_client is None:
        return set()
    try:
        response = await http_client.get("/changes/approved-ids", params={"merchantId": merchant_id})
        response.raise_for_status()
        return set(response.json().get("approved_change_ids", []))
    except Exception:
        logger.warning(
            "failed to fetch approved change ids from storefront-web; treating as none approved",
            exc_info=True,
        )
        return set()


async def _mirror_changes(
    http_client: httpx.AsyncClient | None, merchant_id: str, state: MerchantSessionState
) -> None:
    """POST every change this session has seen to storefront-web's mirror (contract
    b) after a write tool call. Best-effort like ``_post_ui_event`` in the shopping
    server: a failure here must not affect the tool's own result — the operator
    losing sight of a change for a moment is recoverable; failing an otherwise
    successful stage/apply/discard call is not."""
    if http_client is None or not state.seen_changes:
        return
    try:
        response = await http_client.post(
            "/changes/mirror",
            json={
                "merchant_id": merchant_id,
                "changes": [c.model_dump(mode="json") for c in state.seen_changes.values()],
            },
        )
        response.raise_for_status()
    except Exception:
        logger.warning("failed to mirror staged changes to storefront-web", exc_info=True)


async def _run() -> None:
    logging.basicConfig(level=logging.INFO, stream=sys.stderr)
    logger.info(
        "observed CMA_* env names at startup: %s",
        sorted(k for k in os.environ if k.startswith("CMA_")),
    )

    config = _build_config()
    session = _build_session()
    state = _load_state()
    ui_delivery = os.environ.get("CMA_UI_DELIVERY", "result_text")
    backend_base_url = os.environ.get("BACKEND_BASE_URL")

    async with httpx.AsyncClient(
        base_url=backend_base_url or "http://unused.invalid", timeout=10.0
    ) as http_client:
        active_client = http_client if backend_base_url else None
        backend = _build_backend(config, session.merchant_id)
        memory = build_memory(config, JsonFileMemoryStore(MEMORY_FILE))

        executor = MerchantToolExecutor(
            backend=backend,
            config=config,
            skills=SkillRegistry([]),
            session=session,
            state=state,
            memory=memory,
        )

        server: Server = Server(SERVER_NAME, instructions=SERVER_INSTRUCTIONS)

        @server.list_tools()
        async def list_tools() -> list[types.Tool]:
            return [
                types.Tool(
                    name=name,
                    description=str(contract["description"]),
                    inputSchema=published_schema(contract["input_schema"]),
                )
                for name, contract in _tool_contracts(config).items()
            ]

        @server.call_tool()
        async def call_tool(name: str, arguments: dict[str, Any]) -> types.CallToolResult:
            if name == "apply_change":
                # Fresh, never cached — see _fetch_approved_ids's docstring.
                state.approved_change_ids = await _fetch_approved_ids(
                    active_client, session.merchant_id
                )

            outcome: ToolOutcome = await executor.execute(name, arguments)
            _persist_state(state)  # D-R2, minus approved_change_ids — see _persist_state

            if name in CHANGE_MUTATING_TOOLS and not outcome.is_error:
                _persist_ledger(backend.ledger)  # D-R2: survive this turn's process exit
                await _mirror_changes(active_client, session.merchant_id, state)

            # D-R4 presentation delivery — same two modes and the same reasoning as
            # cma-shopping's storefront_stdio_server (see that module's docstring):
            # present_metrics/present_digest/present_change_preview/present_suggestions
            # emit a `ui` AgentEvent through the SAME shared
            # commerce_common.presentation.run_presentation shopping's present_products
            # does, so without this handling their payloads would reach nowhere at all.
            # Gated on `name in PRESENTATION_TOOLS` (not just "does outcome carry a ui
            # event") — see that set's docstring for why: a stage_* call's own
            # informative result_text must not be replaced by its side-effect preview.
            text = outcome.result_text
            ui_event = (
                next((e for e in outcome.events if e.type == "ui"), None)
                if name in PRESENTATION_TOOLS
                else None
            )
            if ui_event is not None and not outcome.is_error and outcome.blocked is None:
                if ui_delivery == "backend_post":
                    await _post_ui_event(
                        active_client,
                        chat_session_id=session.session_id,
                        component=str(ui_event.data.get("component")),
                        payload=ui_event.data.get("payload"),
                    )
                else:
                    envelope: dict[str, Any] = {
                        "displayed": True,
                        "component": ui_event.data.get("component"),
                        "payload": ui_event.data.get("payload"),
                    }
                    if text != executor.displayed_text:
                        envelope["notes"] = text[len(executor.displayed_text) :].strip()
                    text = json.dumps(envelope, ensure_ascii=False)

            return types.CallToolResult(
                content=[types.TextContent(type="text", text=text)],
                isError=outcome.is_error,
            )

        async with stdio_server() as (read_stream, write_stream):
            await server.run(
                read_stream, write_stream, server.create_initialization_options()
            )


def main() -> None:
    anyio.run(_run)


if __name__ == "__main__":
    main()
