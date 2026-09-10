#!/usr/bin/env bash
# agenthub-showcase - Ensure workspace symlinks at runtime.
#
# 有些 CI 的产物/镜像交接会丢掉 pnpm workspace 的符号链接，导致 dist 文件解析不到
# workspace 依赖。这个脚本在启动时幂等地重建 `@showcase/*` 链接作为防御。
#
# 本仓库目前没有 `packages/*`（只有 `apps/storefront-web`），所以它今天是空操作；
# 留在启动路径里，是为了以后加共享包时不用再改启动脚本。

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
WORKSPACE_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"

PACKAGES_DIR="${WORKSPACE_ROOT}/packages"

if [[ ! -d "${PACKAGES_DIR}" ]]; then
  echo "[ensure-workspace-symlinks] packages/ missing at ${PACKAGES_DIR}; nothing to do" >&2
  exit 0
fi

created=0
skipped=0
missing=0

for pkg_dir in "${PACKAGES_DIR}"/*/; do
  [[ -d "${pkg_dir}" ]] || continue
  pkg_json="${pkg_dir%/}/package.json"
  [[ -f "${pkg_json}" ]] || continue

  # Read every `@showcase/*` entry from `dependencies` and `peerDependencies`. We
  # use node (already on the image) instead of jq so we have no extra runtime dep.
  showcase_deps=$(node -e "
    const p = require('${pkg_json}');
    const merged = Object.assign({}, p.dependencies || {}, p.peerDependencies || {});
    for (const name of Object.keys(merged)) {
      if (name.startsWith('@showcase/')) console.log(name);
    }
  ")

  [[ -n "${showcase_deps}" ]] || continue

  pkg_node_modules="${pkg_dir%/}/node_modules/@showcase"
  mkdir -p "${pkg_node_modules}"

  while IFS= read -r dep_name; do
    [[ -n "${dep_name}" ]] || continue
    short="${dep_name#@showcase/}"
    link_path="${pkg_node_modules}/${short}"
    # Relative target: packages/<pkg>/node_modules/@showcase/<dep> →
    # ../../../<dep>  (three `..` to climb out of node_modules/@showcase,
    # then back into the sibling package directory).
    target_relative="../../../${short}"
    target_absolute="${PACKAGES_DIR}/${short}"

    if [[ ! -d "${target_absolute}" ]]; then
      echo "[ensure-workspace-symlinks] packages/${short} missing — cannot link ${link_path}" >&2
      missing=$((missing + 1))
      continue
    fi

    if [[ -L "${link_path}" ]]; then
      current_target=$(readlink "${link_path}" || true)
      if [[ "${current_target}" == "${target_relative}" ]]; then
        skipped=$((skipped + 1))
        continue
      fi
    fi

    ln -sfn "${target_relative}" "${link_path}"
    created=$((created + 1))
  done <<< "${showcase_deps}"
done

echo "[ensure-workspace-symlinks] @showcase/* links: created=${created} skipped=${skipped} missing=${missing}"

if [[ "${missing}" -gt 0 ]]; then
  exit 1
fi
