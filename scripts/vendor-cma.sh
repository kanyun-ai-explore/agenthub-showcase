#!/usr/bin/env bash
# Re-runnable copy from a local clone of upstream commerce-agents into
# agenthub/agents/cma-shopping/runtime/src/. See NOTICE for the full account of
# what is byte-identical vs. adapted, and AGENTS.md for why this repo vendors
# rather than depends on a published package (the seven CMA packages are
# deliberately not registered on PyPI — see upstream's own requirements.txt
# header).
#
# Usage:
#   git clone --depth 50 https://github.com/anthropics/commerce-agents .vendor-src/commerce-agents
#   ./scripts/vendor-cma.sh
#
# Copies the subtrees this repo uses from both agent packages: commerce-common,
# shopping-agent/core + merchant-agent/core, and the slice of examples/ that backs
# each package's own embedded Mock*/ fallback backend. Does not touch
# runtime-agent-sdk, runtime-messages-api, or the example FastAPI hosts — none of
# those run in this repo's stdio servers.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
UPSTREAM="${REPO_ROOT}/.vendor-src/commerce-agents"
AGENT_DIR="${REPO_ROOT}/agenthub/agents/cma-shopping"
SRC_DIR="${AGENT_DIR}/runtime/src"
MERCHANT_AGENT_DIR="${REPO_ROOT}/agenthub/agents/cma-merchant"
MERCHANT_SRC_DIR="${MERCHANT_AGENT_DIR}/runtime/src"

if [[ ! -d "${UPSTREAM}/.git" ]]; then
  echo "error: ${UPSTREAM} is not a git clone of upstream commerce-agents." >&2
  echo "  git clone --depth 50 https://github.com/anthropics/commerce-agents ${UPSTREAM}" >&2
  exit 1
fi

COMMIT="$(git -C "${UPSTREAM}" rev-parse HEAD)"
echo "vendoring from ${UPSTREAM} @ ${COMMIT}"

copy_tree() {
  # copy_tree <src-dir> <dest-dir> [rsync excludes...]
  local src="$1" dest="$2"
  shift 2
  local excludes=("$@")
  local rsync_args=(-a --delete)
  for pattern in "${excludes[@]}"; do
    rsync_args+=(--exclude "${pattern}")
  done
  mkdir -p "${dest}"
  rsync "${rsync_args[@]}" "${src}/" "${dest}/"
}

# -- cma-shopping's adapted files (see NOTICE): the turn's chips ride on any
# presentation component's `suggestions` field. These three are EXCLUDED from the
# overwrite — a plain re-vendor would silently put upstream bytes back while
# CLAUDE.md (derive-claude-md.py patch 3) keeps telling the model to use the
# field, and every turn's chips would vanish with no error pointing here.
# After re-vendoring, diff them against upstream by hand and re-apply.
SHOPPING_ADAPTED=(
  "commerce_common/presentation.py"
  "commerce_common/turn.py"
  "shopping_agent/tools/registry.py"
)

# -- commerce-common: pip-installable as-is -----------------------------------
copy_tree "${UPSTREAM}/commerce-common" "${SRC_DIR}/commerce-common" \
  "tests" "__pycache__" "*.egg-info" ".pytest_cache" \
  "commerce_common/presentation.py" "commerce_common/turn.py"

# -- shopping-agent-core: shopping-agent/core, renamed per its own pyproject -
copy_tree "${UPSTREAM}/shopping-agent/core" "${SRC_DIR}/shopping-agent-core" \
  "tests" "__pycache__" "*.egg-info" ".pytest_cache" \
  "shopping_agent/tools/registry.py"
for f in "${SHOPPING_ADAPTED[@]}"; do
  echo "KEPT (adapted, not overwritten): cma-shopping runtime/src/*/${f} — diff against upstream and re-apply by hand"
done

# -- storefront-stdio-server: our own package's vendored package-data --------
# Only mock_retail.py + the fixtures it reads + the one fixture-helper module it
# imports (storefront_fixtures.py) — not the whole `examples/` tree (its
# merchant/host/session/memory FastAPI scaffolding is unrelated to this stdio
# server; see NOTICE for the demo_common/__init__.py exception).
STDIO_PKG="${SRC_DIR}/storefront-stdio-server/storefront_stdio_server/_examples"

mkdir -p "${STDIO_PKG}/retail/api" "${STDIO_PKG}/retail/data" "${STDIO_PKG}/demo_common"

cp "${UPSTREAM}/examples/retail/api/__init__.py" "${STDIO_PKG}/retail/api/__init__.py"
cp "${UPSTREAM}/examples/retail/api/mock_retail.py" "${STDIO_PKG}/retail/api/mock_retail.py"
touch "${STDIO_PKG}/retail/__init__.py"

for f in catalog.json orders.json policies.json users.json; do
  cp "${UPSTREAM}/examples/retail/data/${f}" "${STDIO_PKG}/retail/data/${f}"
done
# Deliberately NOT copied: memory-seed.json (P0 does no post-turn extraction
# seeding — see reproduction plan D-R5).

# apps/storefront-web's embedded demo backend (M2) reads the SAME fixtures, from
# its own data/retail/ copy — a second destination from this one upstream source
# (not a second source of truth) so a re-vendor updates both together instead of
# the two copies silently drifting apart.
WEB_DATA_DIR="${REPO_ROOT}/apps/storefront-web/data/retail"
mkdir -p "${WEB_DATA_DIR}"
for f in catalog.json orders.json policies.json users.json; do
  cp "${UPSTREAM}/examples/retail/data/${f}" "${WEB_DATA_DIR}/${f}"
done

# The committed reference derive-claude-md.py diffs CLAUDE.md against — see that
# script and its own docstring for why this is system.md (CMA's Managed Agents
# derivation of prompt.py::build_static_system) rather than build_static_system's
# raw output.
mkdir -p "${AGENT_DIR}/runtime/scripts/_vendor-reference"
cp "${UPSTREAM}/shopping-agent/managed-agents/shopping-agent/system.md" \
  "${AGENT_DIR}/runtime/scripts/_vendor-reference/system.md"

cp "${UPSTREAM}/examples/demo_common/storefront_fixtures.py" "${STDIO_PKG}/demo_common/storefront_fixtures.py"
# demo_common/__init__.py is INTENTIONALLY NOT copied from upstream: upstream's
# version re-exports .host/.memory/.merchant/.sessions/.storefront, which pull
# in the CMA example FastAPI host and the merchant runtime — neither is needed
# to import demo_common.storefront_fixtures, and the merchant imports would
# make this shopping-only vendor pass depend on merchant-agent packages we
# don't vendor. See NOTICE. This stub is maintained here, not copied:
cat > "${STDIO_PKG}/demo_common/__init__.py" <<'EOF'
# Intentionally NOT vendored from upstream — see NOTICE and scripts/vendor-cma.sh
# in the agenthub-showcase repo for why. This stub exists only so
# `demo_common.storefront_fixtures` (the one submodule mock_retail.py needs) is
# importable without pulling in upstream's FastAPI example host and merchant
# runtime, which this shopping-only package does not vendor.
EOF

# Each agent package is an independently deployable unit (its own setup.sh installs
# only from its own runtime/src/) — so commerce-common is vendored a SECOND time here,
# not shared from cma-shopping's copy, the same "two destinations, one upstream
# source" reasoning as the storefront-web fixture copies above.
copy_tree "${UPSTREAM}/commerce-common" "${MERCHANT_SRC_DIR}/commerce-common" \
  "tests" "__pycache__" "*.egg-info" ".pytest_cache"

# -- merchant-agent-core: merchant-agent/core, renamed per its own pyproject --
copy_tree "${UPSTREAM}/merchant-agent/core" "${MERCHANT_SRC_DIR}/merchant-agent-core" \
  "tests" "__pycache__" "*.egg-info" ".pytest_cache"

# merchant-stdio-server's vendored MockRetailMerchant wraps a MockRetail instance
# (see that class's docstring in mock_merchant.py), so shopping-agent-core is a real
# runtime dependency of the merchant package too — vendored a second time for the
# same self-containment reason as commerce-common above.
copy_tree "${UPSTREAM}/shopping-agent/core" "${MERCHANT_SRC_DIR}/shopping-agent-core" \
  "tests" "__pycache__" "*.egg-info" ".pytest_cache"

mkdir -p "${MERCHANT_AGENT_DIR}/runtime/scripts/_vendor-reference"
cp "${UPSTREAM}/merchant-agent/managed-agents/merchant-agent/system.md" \
  "${MERCHANT_AGENT_DIR}/runtime/scripts/_vendor-reference/system.md"

# -- merchant-stdio-server: our own package's vendored package-data ----------
# MockRetailMerchant (upstream's reference MerchantBackend) wraps a MockRetail
# instance and needs demo_common.merchant_fixtures alongside storefront_fixtures
# — so this bundle duplicates storefront-stdio-server's retail/mock_retail.py +
# fixtures rather than sharing them: each stdio server is one pip-installable
# package with its own package-data, and the two run as separate processes.
MERCHANT_STDIO_PKG="${MERCHANT_SRC_DIR}/merchant-stdio-server/merchant_stdio_server/_examples"

mkdir -p "${MERCHANT_STDIO_PKG}/retail/api" "${MERCHANT_STDIO_PKG}/retail/data" "${MERCHANT_STDIO_PKG}/demo_common"

cp "${UPSTREAM}/examples/retail/api/__init__.py" "${MERCHANT_STDIO_PKG}/retail/api/__init__.py"
cp "${UPSTREAM}/examples/retail/api/mock_retail.py" "${MERCHANT_STDIO_PKG}/retail/api/mock_retail.py"
cp "${UPSTREAM}/examples/retail/api/mock_merchant.py" "${MERCHANT_STDIO_PKG}/retail/api/mock_merchant.py"
touch "${MERCHANT_STDIO_PKG}/retail/__init__.py"

for f in catalog.json orders.json policies.json users.json \
  merchant_metrics.json merchant_inventory.json merchant_messages.json merchant_campaigns.json; do
  cp "${UPSTREAM}/examples/retail/data/${f}" "${MERCHANT_STDIO_PKG}/retail/data/${f}"
done

cp "${UPSTREAM}/examples/demo_common/storefront_fixtures.py" \
  "${MERCHANT_STDIO_PKG}/demo_common/storefront_fixtures.py"
cp "${UPSTREAM}/examples/demo_common/merchant_fixtures.py" \
  "${MERCHANT_STDIO_PKG}/demo_common/merchant_fixtures.py"
# Same reasoning as storefront-stdio-server's stub (see above and NOTICE): avoids
# pulling in upstream's FastAPI example host via demo_common/__init__.py's
# re-exports.
cat > "${MERCHANT_STDIO_PKG}/demo_common/__init__.py" <<'EOF'
# Intentionally NOT vendored from upstream — see NOTICE and scripts/vendor-cma.sh
# in the agenthub-showcase repo for why. This stub exists only so
# `demo_common.storefront_fixtures`/`demo_common.merchant_fixtures` are importable
# without pulling in upstream's FastAPI example host.
EOF

# 固定数据本地化：金额换人民币、加语言偏好。必须在拷贝之后跑 —— 上面每一处
# cp 都会把上游原文覆盖回去，手改的本地化活不过这一步（踩过）。脚本幂等。
echo "localizing fixtures (CNY prices, zh preferences)..."
python3 "${REPO_ROOT}/scripts/localize-fixtures.py"

echo "done. Refreshing the pinned commit in NOTICE..."
sed -i.bak -E "s/(Commit: )[0-9a-f]{40}/\1${COMMIT}/" "${REPO_ROOT}/NOTICE"
rm -f "${REPO_ROOT}/NOTICE.bak"

cat <<EOF

Vendored @ ${COMMIT}. NOTICE's commit line was updated automatically.

Not auto-updated (grep for the old commit and check by hand if it moved):
  - agenthub/agents/cma-shopping/CLAUDE.md (header comment)
  - agenthub/agents/cma-shopping/.claude/skills/*/SKILL.md (header comments)
  - agenthub/agents/cma-shopping/runtime/scripts/_vendor-reference/*.md (derive-claude-md.py's source)
  - agenthub/agents/cma-merchant/CLAUDE.md (header comment)
  - agenthub/agents/cma-merchant/.claude/skills/*/SKILL.md (header comments)
These only need updating if the upstream file they were derived from actually
changed — a commit bump alone with unchanged upstream content is fine to leave.
EOF
