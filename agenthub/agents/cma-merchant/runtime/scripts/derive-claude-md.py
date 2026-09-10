#!/usr/bin/env python3
"""Re-runnable derivation of this package's CLAUDE.md from CMA's own Managed Agents
``system.md`` (see ``scripts/lib/claude_md_derivation.py`` for why system.md rather
than literally calling ``merchant_agent.prompt.build_static_system`` — same reasoning
as cma-shopping's derive-claude-md.py, not repeated here).

One patch on top of system.md (in addition to appending ``SKILL_TOOL_ADAPTER``, shared
with cma-shopping): every occurrence of "the preview card's approval prompt" is
replaced with this deployment's actual approval surface string. CMA's own reference
system.md was derived with ``approval_surface="the preview card's approval prompt"``
and ``stage_shows_preview=False`` — it assumes the platform's own confirmation dialog
on ``apply_change`` (``always_ask``) doubles as the approval UI. This deployment has no
such dialog: approval happens on ``apps/storefront-web``'s own ``/operator`` page (D-R6
/ reproduction plan §6 contract b), so the text has to say that instead, and
``stage_shows_preview`` stays at its default True (see ``__main__.py``'s
``_build_config`` comment) — no patch is needed for that flag; see this script's
module docstring in the sibling package for the "why no patch" reasoning, unchanged
here since no sentence in system.md is conditioned on that flag's value.

Usage::

    python runtime/scripts/derive-claude-md.py          # diff-check (exit 1 on mismatch)
    python runtime/scripts/derive-claude-md.py --write  # overwrite CLAUDE.md in place
"""

from __future__ import annotations

import sys
from pathlib import Path

AGENT_DIR = Path(__file__).resolve().parent.parent.parent
REPO_ROOT = AGENT_DIR.parent.parent.parent
sys.path.insert(0, str(REPO_ROOT / "scripts" / "lib"))

from claude_md_derivation import (  # noqa: E402
    append_skill_adapter,
    diff_and_exit,
    extract_skill_tool_adapter,
    strip_header_comment,
)

SYSTEM_MD = AGENT_DIR / "runtime" / "scripts" / "_vendor-reference" / "system.md"
AGENT_SDK_PY = (
    AGENT_DIR / "runtime" / "src" / "commerce-common" / "commerce_common" / "agent_sdk.py"
)
CLAUDE_MD = AGENT_DIR / "CLAUDE.md"

# Must match __main__.py's _build_config default and agent.yaml's CMA_APPROVAL_SURFACE.
APPROVAL_SURFACE = "the operator portal's approval page"
UPSTREAM_APPROVAL_SURFACE = "the preview card's approval prompt"


def substitute_approval_surface(body: str) -> str:
    count = body.count(UPSTREAM_APPROVAL_SURFACE)
    if count == 0:
        raise ValueError(
            f"{UPSTREAM_APPROVAL_SURFACE!r} not found in system.md — upstream wording "
            "moved; re-check this substitution by hand before trusting the diff."
        )
    return body.replace(UPSTREAM_APPROVAL_SURFACE, APPROVAL_SURFACE)


def derive() -> str:
    if not SYSTEM_MD.exists():
        raise SystemExit(
            f"{SYSTEM_MD} is missing. Run scripts/vendor-cma.sh from the repo root first."
        )
    body = strip_header_comment(SYSTEM_MD.read_text(encoding="utf-8"))
    body = substitute_approval_surface(body)
    skill_tool_adapter = extract_skill_tool_adapter(AGENT_SDK_PY)
    return append_skill_adapter(body, skill_tool_adapter)


def main() -> None:
    derived = derive()
    if "--write" in sys.argv[1:]:
        header = CLAUDE_MD.read_text(encoding="utf-8")
        end = header.index("-->") + len("-->")
        CLAUDE_MD.write_text(header[:end] + "\n\n" + derived, encoding="utf-8")
        print(f"wrote {CLAUDE_MD}")
        return
    diff_and_exit(derived, CLAUDE_MD)


if __name__ == "__main__":
    main()
