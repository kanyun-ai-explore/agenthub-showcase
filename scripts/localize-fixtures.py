#!/usr/bin/env python3
"""把 vendor 下来的固定数据本地化：金额换成人民币，给 demo-user 加语言偏好。

为什么是脚本而不是手改：`vendor-cma.sh` 每次都从 `.vendor-src` 把这些文件整个
覆盖到三个目的地（app 的 data/retail、shopping 和 merchant 两个 agent 包的
_examples）。手改的结果活不过下一次 vendor —— 之前给 demo-user 加语言偏好就是
手改的，这次一并收进来。

vendor-cma.sh 在拷完之后调它，所以顺序永远是「上游内容 + 本地化」。

幂等：认 `_localized` 标记，已处理过的文件直接跳过，重复跑不会把价格乘两遍。

用法::

    python3 scripts/localize-fixtures.py            # 处理仓库里三份拷贝
    python3 scripts/localize-fixtures.py <dir>...   # 只处理指定目录
"""

from __future__ import annotations

import json
import re
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent

# 三个 vendor 目的地，与 vendor-cma.sh 里的路径一一对应。
TARGETS = [
    REPO / "apps/storefront-web/data/retail",
    REPO / "agenthub/agents/cma-shopping/runtime/src/storefront-stdio-server"
         / "storefront_stdio_server/_examples/retail/data",
    REPO / "agenthub/agents/cma-merchant/runtime/src/merchant-stdio-server"
         / "merchant_stdio_server/_examples/retail/data",
]

# 汇率取整数 7，然后把尾数抹成 9 —— 演示数据，要的是「看起来像国内电商的价」，
# 不是精确汇率。抹尾在 10 元以上才做，免得 5.99 变成 9。
RATE = 7

# 金额字段。`total` 不在这里：它由 items 重算，避免明细和合计对不上（agent 会
# 拿这些数做算术，对不上就会当场露馅）。
MONEY_KEYS = {"price", "unit_cost", "subtotal", "promotion_price", "list_price", "cost"}

MARKER = "_localized"


def to_cny(usd: float) -> float:
    value = usd * RATE
    if value >= 10:
        # 抹到尾数 9：1043 -> 1049，553 -> 559
        return float(int(value) - int(value) % 10 + 9)
    return round(value, 2)


# 币种写进数据，不改代码默认值：Python 那边 `currency: str = "USD"` 在
# shopping_agent/types.py 里，跟固定数据一样是 vendor 下来的，改了同样活不过
# 下一次 vendor。数据里显式写死，默认值就永远轮不到。
CURRENCY_OWNERS = ("product_id", "order_id")


def walk(node):
    """就地转换金额字段，返回是否改过。"""
    changed = False
    if isinstance(node, dict):
        for key, value in list(node.items()):
            if key in MONEY_KEYS and isinstance(value, (int, float)):
                node[key] = to_cny(float(value))
                changed = True
            elif key == "currency" and value in ("USD", "usd"):
                node[key] = "CNY"
                changed = True
            else:
                changed |= walk(value)
        # 商品和订单显式带上币种，免得落到代码里的 USD 默认值
        if any(k in node for k in CURRENCY_OWNERS) and "currency" not in node:
            node["currency"] = "CNY"
            changed = True
        # 合计由明细重算，不单独换算
        items = node.get("items")
        if isinstance(items, list) and "total" in node:
            node["total"] = round(
                sum(float(i.get("price", 0)) * int(i.get("quantity", 1)) for i in items), 2
            )
    elif isinstance(node, list):
        for value in node:
            changed |= walk(value)
    return changed


DOLLAR = re.compile(r"\$(\d+(?:\.\d+)?)")


def localize_text(node) -> bool:
    """政策条文之类的正文里也写着金额，一并换掉。"""
    changed = False
    if isinstance(node, dict):
        for key, value in list(node.items()):
            if isinstance(value, str) and "$" in value:
                node[key] = DOLLAR.sub(lambda m: f"¥{to_cny(float(m.group(1))):g}", value)
                changed = True
            else:
                changed |= localize_text(value)
    elif isinstance(node, list):
        for value in node:
            changed |= localize_text(value)
    return changed


def localize_users(data: dict) -> bool:
    """demo-user 加一条语言偏好。

    放在固定数据而不是系统提示词里：CLAUDE.md 是 derive-claude-md.py 从上游
    system.md 推出来的、带 diff 校验，不该为了演示去改；而「按用户偏好调整回复」
    本来就是 get_preferences 这条能力自己要演示的东西。
    """
    changed = False
    for user in data.get("users", []):
        prefs = user.get("preferences")
        if user.get("user_id") == "demo-user" and isinstance(prefs, dict) and "language" not in prefs:
            user["preferences"] = {"language": "简体中文，回复请用中文", **prefs}
            changed = True
    return changed


def process(path: Path) -> bool:
    data = json.loads(path.read_text(encoding="utf-8"))
    if isinstance(data, dict) and data.get(MARKER):
        return False

    changed = walk(data)
    changed |= localize_text(data)
    if path.name == "users.json":
        changed |= localize_users(data)

    if isinstance(data, dict):
        data[MARKER] = True
    path.write_text(json.dumps(data, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    return changed


def main() -> int:
    dirs = [Path(a) for a in sys.argv[1:]] or TARGETS
    total = 0
    for directory in dirs:
        if not directory.is_dir():
            print(f"跳过（不存在）: {directory}")
            continue
        for path in sorted(directory.glob("*.json")):
            if process(path):
                total += 1
                print(f"已本地化 {path.relative_to(REPO)}")
    print(f"共处理 {total} 个文件")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
