# Deriving `CLAUDE.md` from upstream CMA

This is the manual procedure used to produce `../../CLAUDE.md` (reproduction plan
§3.2). M2 turns this into a script
(`derive-claude-md.py`, importing CMA's own `shopping_agent.prompt.build_static_system`
plus the patches below, with a diff check against the committed file so a re-run
either matches or loudly disagrees) — until then, re-derivation is manual and this
file is the record of what was done and why, so a re-derivation doesn't silently
drop a patch.

## Starting point

`shopping-agent/managed-agents/shopping-agent/system.md` at commit
`fd4d59224ab96b43c6dc6888207c67b3bd5a24cf` (see `NOTICE`) — **not**
`shopping_agent.prompt.build_static_system`'s raw output. system.md is CMA's own
already-adapted prompt for their Managed Agents hosted path (host-executed
presentation tools, MCP-delivered storefront tools, no `load_skill` tool, a prose
skill summary instead of `build_static_system`'s generated `skills.index_block()`).
It is the closer starting point: our deployment is also a hosted path with
MCP-delivered storefront tools and host-rendered-ish presentation (mode A puts the
payload in the MCP result; the UI still renders it), just with Claude Code's
`Skill` tool instead of the Managed Agents platform's native skill attachment.

## Patches applied, in order

1. **Dropped** system.md's own HTML comment header (references
   `scripts/check.py` and `scripts/deploy_managed_agent.sh`, which don't exist in
   this repo's pipeline) and replaced it with this repo's own header comment
   (see the top of `CLAUDE.md`), listing the same four `adapted:` bullets
   system.md's header already listed (inline-context wording for memory/account —
   all still true here, since this deployment also has no per-request Session
   context block) plus the two new patches below.
2. **Inserted** one new bullet at the top of the `# Presentation` section:
   an instruction not to restate a `present_*`/`checkout` result's payload in
   prose. Needed specifically because this deployment's stdio server runs in
   D-R4 mode A (`CMA_UI_DELIVERY=result_text`): the MCP tool result is a JSON
   envelope carrying the full enriched payload, not just
   `"Displayed to the customer."`. Without this line, a model that can now "see"
   the payload in its own tool result has more surface to (incorrectly)
   summarize it in text — system.md's existing "do not repeat in text what a
   component shows" bullet (kept, unchanged, in `# How you work`) covers the
   general case but predates a payload-bearing tool result.

   **This patch is mode-specific.** If/when the agent's `env.CMA_UI_DELIVERY`
   moves to `backend_post` (M2), the tool result reverts to CMA's plain
   confirmation text and this bullet becomes unnecessary (harmless to leave in —
   it's still true — but re-derivation should reconsider it).
3. **Appended**, verbatim, at the very end of the document: CMA's own
   `commerce_common.agent_sdk.SKILL_TOOL_ADAPTER` text (the "# Skill loading in
   this deployment" section). This is the exact patch CMA's own Agent SDK runtime
   applies on top of `build_static_system`'s output, for the same reason we need
   it here: skills load through a `Skill` tool call, not system.md's assumption of
   native host attachment (no tool call) or `build_static_system`'s own
   `load_skill` tool.

   **Known imprecision, left as upstream wrote it**: the adapter's last sentence
   says "invoke `Skill` ... matches a skill's description in the index above" —
   but system.md's "# Skills" section is prose (five named flow categories), not
   a literal per-skill index like `build_static_system`'s `skills.index_block()`
   produces. CMA's own SDK runtime has this same mismatch whenever it is pointed
   at a prompt without a literal index (its default prompt, from
   `build_static_system`, does have one; ours doesn't). Left as-is rather than
   silently rewording upstream's patch text — Claude Code's own harness also
   surfaces the discovered `.claude/skills/*/SKILL.md` descriptions to the model
   independently of this file's prose, which is most of what "the index above"
   is standing in for in practice.
4. **Left unchanged**: brand ("ACME" / "ACME Assistant") — this package's
   `agent.yaml` sets `CMA_BRAND_NAME=ACME` / `CMA_ASSISTANT_NAME="ACME Assistant"`,
   matching system.md's hardcoded values exactly, so no templating was needed for
   this single-brand demo. The "Tools" section's "storefront tools ... run ...
   through the storefront connection" sentence is also unchanged — it reads
   correctly for an MCP-delivered tool surface regardless of transport (HTTP in
   CMA's Managed Agents path, stdio here).

## Verification

`wc -c CLAUDE.md` was 12,995 at last derivation — well under the 32,768-char hard
limit (`agenthub agent check` layer ② / pipeline `join`'s
`FILE_AGENT_DEFINITION_DOC_OVERSIZE`).
