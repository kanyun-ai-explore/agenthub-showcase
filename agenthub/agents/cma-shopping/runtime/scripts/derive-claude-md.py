#!/usr/bin/env python3
"""Re-runnable version of the manual derivation this package's CLAUDE.md was produced
by (see ``derive-claude-md.md`` for the original step-by-step record, and
``scripts/lib/claude_md_derivation.py`` — imported below — for why this reads
``_vendor-reference/system.md`` rather than literally calling
``shopping_agent.prompt.build_static_system``).

Three patches on top of system.md, matching CLAUDE.md's own header comment exactly:

1. insert one bullet at the top of "# Presentation" — needed because this deployment's
   stdio server (``CMA_UI_DELIVERY=result_text``, D-R4 mode A) puts the full enriched
   payload inside the tool's own MCP result text, not just system.md's assumed
   "Displayed to the customer." confirmation.
2. append ``commerce_common.agent_sdk.SKILL_TOOL_ADAPTER`` verbatim — this deployment
   loads skills through Claude Code's native ``Skill`` tool, not system.md's assumed
   host-native attachment or CMA's own ``load_skill`` tool.
3. replace the chips sentence in the "# Presentation" chips bullet — this deployment's
   presentation tools take the turn's chips in a ``suggestions`` field on the last
   component (``PresentationPayload.suggestions``), so the chips no longer cost a model
   round of their own; ``present_suggestions`` stays for the turn with no component.

Usage::

    python runtime/scripts/derive-claude-md.py          # diff-check (exit 1 on mismatch)
    python runtime/scripts/derive-claude-md.py --write  # overwrite CLAUDE.md in place

Wire this into a pre-push check (``scripts/check.sh``) the same way CMA's own
``scripts/check.py`` polices its prompt-builder bullets against system.md.
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

PRESENTATION_NOTE = (
    '- A present_* (or checkout) result already contains everything the customer sees, '
    'however it is carried alongside the confirmation text: do not quote, restate, or '
    're-format any part of it in your reply. Treat every such call exactly as '
    '"Displayed to the customer." and nothing more.'
)


CHIPS_SENTENCE_UPSTREAM = (
    "Call present_suggestions together with the turn's last component, in the same round, "
    "without waiting for that component's result; present_suggestions on its own in a "
    "later round is wrong, and only a turn with no component calls it alone, after the "
    "text."
)
CHIPS_SENTENCE = (
    "Put the chips in the `suggestions` field of the turn's last component, in that same "
    "call; calling present_suggestions after a component, in the same round or a later "
    "one, is wrong, and only a turn with no component calls present_suggestions, alone, "
    "after the text."
)


CHIPS_OPENING_UPSTREAM = "ends with chips, up to 4, through present_suggestions, "
CHIPS_OPENING = (
    "ends with chips, up to 4, carried on its last component (or, with no component, "
    "through present_suggestions), "
)


def replace_chips_sentence(body: str) -> str:
    for upstream, ours in ((CHIPS_OPENING_UPSTREAM, CHIPS_OPENING), (CHIPS_SENTENCE_UPSTREAM, CHIPS_SENTENCE)):
        if body.count(upstream) != 1:
            raise SystemExit(
                f"system.md no longer carries the chips wording this patch replaces ({upstream[:40]!r}); "
                "re-derive patch 3 against the new upstream wording before re-vendoring."
            )
        body = body.replace(upstream, ours)
    return body


def insert_presentation_note(body: str) -> str:
    anchor = "# Presentation\n\n"
    index = body.index(anchor)
    insert_at = index + len(anchor)
    return body[:insert_at] + PRESENTATION_NOTE + "\n\n" + body[insert_at:]


def derive() -> str:
    if not SYSTEM_MD.exists():
        raise SystemExit(
            f"{SYSTEM_MD} is missing. Run scripts/vendor-cma.sh from the repo root first "
            "(it vendors this reference copy alongside the CMA packages)."
        )
    body = strip_header_comment(SYSTEM_MD.read_text(encoding="utf-8"))
    body = insert_presentation_note(body)
    body = replace_chips_sentence(body)
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
