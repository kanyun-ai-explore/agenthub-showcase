#!/usr/bin/env bash
# 把共用的教育 MCP 同步进各教育 agent 的目录。
#
# ⚠️ 重跑会把 shared/ 的**当前**内容刷进下面每一个 agent：shared 改了、某个 agent 又不该
# 在这一批发版里动，就别整脚本跑，按 agent 单独同步。
#
# 为什么要复制而不是共享一份：agent 包是按 agent **自己的目录**打的，沙箱里只有
# `/workspace/.session/agent-package/` 这一棵树。任何 agent 目录之外的代码在运行时
# 都不存在——PYTHONPATH 指过去就是空的。仓库里 cma-merchant 同样自带一份
# shopping-agent-core 副本，是同一个原因。
#
# 事实源是 shared/course-stdio-server，各 agent 目录下的副本由这个脚本生成，不要手改副本。
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SRC="$ROOT/shared/course-stdio-server"

for agent in edu-course-sales edu-math-tutor edu-chinese-tutor edu-homework-qa edu-learning-analytics edu-english-coach; do
  DEST="$ROOT/agenthub/agents/$agent/runtime/src/course-stdio-server"
  rm -rf "$DEST"
  mkdir -p "$(dirname "$DEST")"
  cp -R "$SRC" "$DEST"
  find "$DEST" -name "__pycache__" -type d -exec rm -rf {} + 2>/dev/null || true
  echo "已同步 -> agenthub/agents/$agent/runtime/src/course-stdio-server"
done

# 为什么源头在 shared/ 而不是 agenthub/agents/edu-shared/：
# `agenthub/agents/` 下的每个目录平台都当成一个 agent，没有 agent.yaml 就报
# PIPELINE_INVALID_AGENT_YAML，流水线的 plan 步就挂在这一步。
