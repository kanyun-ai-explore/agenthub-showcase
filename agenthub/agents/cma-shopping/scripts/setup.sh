#!/usr/bin/env bash
# LOCAL DEV ONLY (`agenthub agent dev`). Not referenced from agent.yaml any more:
# the platform runs setup scripts at sandbox startup, before the agent package is
# unpacked, so this `pip install` of the package's own dirs cannot work there
# (measured: every eval session fails the setup gate). On the platform the
# packages are imported via
# PYTHONPATH (agent.yaml `env`). Third-party deps stay in the `cma-python`
# Environment image. Idempotent on a persistent local workspace.
set -euo pipefail
[ -f "$HOME/.cma-setup-done" ] && exit 0

PKG=/workspace/.session/agent-package   # agent package install root (platform convention)

# --break-system-packages: the platform base image ships a Debian-managed python
# (PEP 668). Without it pip refuses with `error: externally-managed-environment`
# and the setup_script gate fails the session (SETUP_SCRIPT_FAILED). The platform's own
# Environment bake passes the same flag for `config.packages.pip`.
pip install --user --no-deps --break-system-packages \
  "$PKG/runtime/src/commerce-common" \
  "$PKG/runtime/src/shopping-agent-core" \
  "$PKG/runtime/src/storefront-stdio-server"

touch "$HOME/.cma-setup-done"
