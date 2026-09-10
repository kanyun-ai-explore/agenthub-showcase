#!/usr/bin/env bash
# LOCAL DEV ONLY (`agenthub agent dev`) — same status and reason as
# cma-shopping/scripts/setup.sh: not referenced from agent.yaml; the platform
# imports the vendored packages via PYTHONPATH instead. Idempotent locally.
set -euo pipefail
[ -f "$HOME/.cma-setup-done" ] && exit 0

PKG=/workspace/.session/agent-package   # agent package install root (platform convention)

# --break-system-packages: same reason as cma-shopping/scripts/setup.sh — the
# platform base image's python is Debian-managed (PEP 668) and pip refuses
# `--user` installs without it (exit 1 → SETUP_SCRIPT_FAILED).
pip install --user --no-deps --break-system-packages \
  "$PKG/runtime/src/commerce-common" \
  "$PKG/runtime/src/shopping-agent-core" \
  "$PKG/runtime/src/merchant-agent-core" \
  "$PKG/runtime/src/merchant-stdio-server"

touch "$HOME/.cma-setup-done"
