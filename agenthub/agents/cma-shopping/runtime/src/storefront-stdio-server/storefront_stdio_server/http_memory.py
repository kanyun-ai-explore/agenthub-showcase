"""HTTP ``MemoryStore`` adapter (reproduction plan §6 contract c). New code for this
repo: a duck-typed implementation of ``commerce_common.memory.MemoryStore`` (a
``Protocol`` — no base class to inherit, ``check_memory_store`` verifies the six
methods structurally at startup) that calls out to ``BACKEND_BASE_URL`` instead of a
local JSON file, so cross-session memory recall survives this process exiting (D-R2)
even when the *state directory itself* does not (e.g. a sandbox rebuild between
sessions) — durability moves to the backend, same as the cart already does under
:class:`~storefront_stdio_server.http_backend.HttpStorefrontBackend`.

Six endpoints, all against ``BACKEND_BASE_URL``, all carrying ``subject_id`` explicitly
in the body rather than in a header: unlike the storefront contract, a memory subject
is not implicitly "whoever this process serves" — ``recall_memories``/``save_memory``
already resolve their own subject id upstream of this adapter (see
``shopping_agent.executor``), and this adapter is intentionally a thin transport, not a
second place that decides identity.
"""

from __future__ import annotations

import httpx
from commerce_common.types import MemoryFact


class HttpMemoryStore:
    def __init__(self, client: httpx.AsyncClient) -> None:
        self._client = client

    async def _post(self, path: str, body: dict) -> dict:
        response = await self._client.post(path, json=body)
        response.raise_for_status()
        return response.json()

    async def get_facts(self, subject_id: str) -> list[MemoryFact]:
        data = await self._post("/memory/get-facts", {"subject_id": subject_id})
        return [MemoryFact.model_validate(item) for item in data["facts"]]

    async def upsert_facts(self, subject_id: str, facts: list[MemoryFact]) -> None:
        await self._post(
            "/memory/upsert-facts",
            {
                "subject_id": subject_id,
                "facts": [fact.model_dump(mode="json") for fact in facts],
            },
        )

    async def search_facts(self, subject_id: str, query: str) -> list[MemoryFact]:
        data = await self._post("/memory/search-facts", {"subject_id": subject_id, "query": query})
        return [MemoryFact.model_validate(item) for item in data["facts"]]

    async def delete_fact(self, subject_id: str, key: str) -> bool:
        data = await self._post("/memory/delete-fact", {"subject_id": subject_id, "key": key})
        return bool(data.get("deleted", False))

    async def clear(self, subject_id: str) -> None:
        await self._post("/memory/clear", {"subject_id": subject_id})

    async def purge_generation(self, subject_id: str) -> int:
        data = await self._post("/memory/purge-generation", {"subject_id": subject_id})
        return int(data.get("generation", 0))
