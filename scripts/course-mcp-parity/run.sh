#!/usr/bin/env bash
#
# course MCP 移植对拍：TypeScript 实现（lib/course/mcp-tools.ts，走 HTTP MCP）
# 与上游 stdio 实现（shared/course-stdio-server，Python）在同一组入参下输出是否一致。
#
# 为什么是脚本不是单测：本仓库没有测试框架（apps/storefront-web 只有
# `tsc --noEmit`），为一次移植引入 vitest 的代价大于收益。这个脚本是该移植的
# 验证手段，改动 mcp-tools.ts 或上游 stdio server 后都应重跑。
#
# 已知的、可接受的差异（脚本会自动忽略）：Python 的 float 字面量写作 `1.0` / `0.0`，
# JS 的 JSON.stringify 只能写 `1` / `0`。两者 JSON.parse 后是同一个数，模型读到的
# 也是同一个数；JS 侧无法产出 `1.0`，不为此扭曲实现。
#
# 用法：bash scripts/course-mcp-parity/run.sh
# 退出码：0 = 一致，1 = 有实质差异（原文打印到 stderr）

set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "${HERE}/../.." && pwd)"
PY_SRC="${ROOT}/shared/course-stdio-server/course_stdio_server/__main__.py"
TS_SRC="${ROOT}/apps/storefront-web/lib/course/mcp-tools.ts"

for f in "${PY_SRC}" "${TS_SRC}"; do
  [ -f "${f}" ] || { echo "缺少 ${f}"; exit 1; }
done

TMP="$(mktemp -d)"
trap 'rm -rf "${TMP}"' EXIT

python3 "${HERE}/py_side.py" "${PY_SRC}" > "${TMP}/py.json"
# cwd 必须是 apps/storefront-web：工具按 process.cwd()/data/course 解析数据目录
(cd "${ROOT}/apps/storefront-web" && node --experimental-strip-types "${HERE}/ts_side.mjs" \
  "${ROOT}/apps/storefront-web/lib/course/mcp-tools.ts" 2>/dev/null) > "${TMP}/ts.json"

# 归一化 float 字面量后再比：只动「整数值的 .0 后缀」，不碰 0.5 这类真小数
norm() { sed -E 's/: ([0-9]+)\.0([,]?)$/: \1\2/' "$1"; }
norm "${TMP}/py.json" > "${TMP}/py.norm"
norm "${TMP}/ts.json" > "${TMP}/ts.norm"

if diff -u "${TMP}/py.norm" "${TMP}/ts.norm" > "${TMP}/diff.txt"; then
  echo "✅ course MCP 对拍一致（12 组用例）"
  exit 0
fi

echo "❌ course MCP 对拍有差异：" >&2
cat "${TMP}/diff.txt" >&2
exit 1
