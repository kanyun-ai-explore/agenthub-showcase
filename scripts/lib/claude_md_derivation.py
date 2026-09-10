"""Shared machinery for both agents' ``runtime/scripts/derive-claude-md.py``: strip a
CLAUDE.md-style header comment, extract ``SKILL_TOOL_ADAPTER`` from the vendored
``commerce_common.agent_sdk`` source without importing it (that module requires
``claude-agent-sdk``, a heavy optional dependency neither agent package installs — see
its own module docstring), and diff a derived body against what is committed.

Design note (read before "fixing" this to literally call ``build_static_system``): the
reproduction plan's §3.2 sentence describing this script says "import CMA
build_static_system" — written before the M1 CLAUDE.md was actually produced, which
starts from CMA's own Managed Agents ``system.md`` instead (see each package's
``_vendor-reference/system.md`` and the CLAUDE.md header comment it produces). system.md
is itself CMA's derivation of ``build_static_system`` for a hosted-MCP, no-per-request-
context-block deployment — closer to this repo's shape than calling
``build_static_system`` directly would produce (that function assumes a live skill
index and session-context block neither of these stdio deployments have). Automating
anything other than what is actually committed would make the "diff against CLAUDE.md"
check in this file fail by construction, so this script formalizes the system.md-based
procedure, not the plan sentence's literal wording.
"""

from __future__ import annotations

import ast
import sys
from pathlib import Path


def strip_header_comment(text: str) -> str:
    """Remove one leading ``<!-- ... -->`` block (and the blank line after it), if the
    text starts with one. Both CLAUDE.md and system.md begin this way; the header is
    meta-documentation (attribution, patch list) that this script does not try to
    reproduce or diff — only the substantive, model-visible content below it."""
    stripped = text.lstrip("\n")
    if not stripped.startswith("<!--"):
        return stripped
    end = stripped.index("-->") + len("-->")
    return stripped[end:].lstrip("\n")


def extract_skill_tool_adapter(agent_sdk_py: Path) -> str:
    """The ``SKILL_TOOL_ADAPTER`` string constant, read out of the vendored
    ``commerce_common/agent_sdk.py`` source via ``ast`` rather than importing the
    module — importing it would require installing ``claude-agent-sdk`` (an optional,
    heavy dependency neither agent package's Environment installs) just to read one
    string constant. This still reads the REAL CMA source text (our own vendored copy,
    byte-identical to upstream), so an upstream wording change is still caught the next
    time this script runs — the anti-drift property scripts/vendor-cma.sh and CMA's own
    scripts/check.py both care about, without the import cost.
    """
    tree = ast.parse(agent_sdk_py.read_text(encoding="utf-8"))
    for node in ast.walk(tree):
        if (
            isinstance(node, ast.Assign)
            and len(node.targets) == 1
            and isinstance(node.targets[0], ast.Name)
            and node.targets[0].id == "SKILL_TOOL_ADAPTER"
        ):
            value = ast.literal_eval(node.value)
            if not isinstance(value, str):
                raise TypeError("SKILL_TOOL_ADAPTER is not a string constant")
            return value
    raise ValueError(f"SKILL_TOOL_ADAPTER assignment not found in {agent_sdk_py}")


def append_skill_adapter(body: str, skill_tool_adapter: str) -> str:
    return body.rstrip("\n") + "\n\n" + skill_tool_adapter.rstrip("\n") + "\n"


def diff_and_exit(derived: str, committed_path: Path) -> None:
    """Compare ``derived`` against ``committed_path`` (after stripping ITS header
    comment the same way) and exit non-zero with a unified diff on mismatch, or print a
    one-line confirmation and return on match."""
    import difflib

    committed_body = strip_header_comment(committed_path.read_text(encoding="utf-8"))
    if derived == committed_body:
        print(f"OK: {committed_path} matches its derivation.")
        return
    diff = "\n".join(
        difflib.unified_diff(
            committed_body.splitlines(),
            derived.splitlines(),
            fromfile=f"{committed_path} (committed, header stripped)",
            tofile="derived",
            lineterm="",
        )
    )
    print(f"MISMATCH: {committed_path} does not match its derivation.\n\n{diff}", file=sys.stderr)
    sys.exit(1)
