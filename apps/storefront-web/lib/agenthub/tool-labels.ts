/**
 * 工具轨迹的中文名。名字取自两个 agent 各自注册的工具表
 * （`runtime/tests/smoke_stdio.py` 的 EXPECTED_TOOLS），所以这张表可以对着核。
 * 表里没有的降级显示原名，不隐藏——真的被调用过的工具必须看得见。
 */

export type ToolKind = "read" | "write" | "present" | "memory";

interface ToolLabel {
  label: string;
  kind: ToolKind;
}

const LABELS: Record<string, ToolLabel> = {
  // 导购侧
  search_products: { label: "检索商品", kind: "read" },
  get_product_details: { label: "查看商品详情", kind: "read" },
  get_cart: { label: "读取购物车", kind: "read" },
  add_to_cart: { label: "加入购物车", kind: "write" },
  update_cart_item: { label: "调整购物车", kind: "write" },
  remove_from_cart: { label: "移出购物车", kind: "write" },
  get_preferences: { label: "读取用户偏好", kind: "read" },
  get_orders: { label: "查询历史订单", kind: "read" },
  get_order_status: { label: "查询订单状态", kind: "read" },
  search_policies: { label: "查询售后政策", kind: "read" },
  get_fulfillment_options: { label: "查询配送方式", kind: "read" },
  checkout: { label: "生成结算单", kind: "present" },
  present_products: { label: "渲染商品卡片", kind: "present" },
  present_comparison: { label: "渲染对比表", kind: "present" },
  present_plan: { label: "渲染方案清单", kind: "present" },
  present_guide: { label: "渲染选购指南", kind: "present" },
  present_order_status: { label: "渲染订单卡片", kind: "present" },
  present_suggestions: { label: "生成追问建议", kind: "present" },
  save_memory: { label: "记住这条偏好", kind: "memory" },
  recall_memories: { label: "召回记忆", kind: "memory" },

  // 商家侧
  get_business_snapshot: { label: "拉取经营快照", kind: "read" },
  query_metrics: { label: "查询经营指标", kind: "read" },
  get_campaign_performance: { label: "查询活动效果", kind: "read" },
  search_listings: { label: "检索在售商品", kind: "read" },
  get_listing: { label: "查看商品档案", kind: "read" },
  get_inventory_alerts: { label: "拉取库存告警", kind: "read" },
  get_order_issues: { label: "拉取订单异常", kind: "read" },
  get_pricing_context: { label: "读取定价上下文", kind: "read" },
  get_pending_changes: { label: "查看待审改动", kind: "read" },
  present_metrics: { label: "渲染指标卡", kind: "present" },
  present_digest: { label: "渲染经营摘要", kind: "present" },
  present_change_preview: { label: "渲染改动预览", kind: "present" },
  stage_listing_update: { label: "拟定商品改动", kind: "write" },
  stage_price_update: { label: "拟定调价方案", kind: "write" },
  stage_inventory_action: { label: "拟定库存操作", kind: "write" },
  stage_promotion: { label: "拟定促销方案", kind: "write" },
  stage_campaign: { label: "拟定营销活动", kind: "write" },
  apply_change: { label: "执行已批准的改动", kind: "write" },
  discard_change: { label: "丢弃改动", kind: "write" },

  // 教育侧
  get_lesson: { label: "读取课件", kind: "read" },
  get_student_progress: { label: "查询学习进度", kind: "read" },
  get_weekly_report: { label: "拉取学情周报", kind: "read" },
  get_course_catalog: { label: "查询课程与价格", kind: "read" },
  get_trial_slots: { label: "查询试听排期", kind: "read" },
  present_slide: { label: "翻课件", kind: "present" },
  present_course_plan: { label: "渲染课程方案", kind: "present" },
  present_trial_slots: { label: "渲染试听排期", kind: "present" },
  present_correction: { label: "渲染批改结果", kind: "present" },
  present_report: { label: "渲染学情周报", kind: "present" },
};

/** `mcp__storefront__search_products` → `search_products`。 */
export function shortToolName(name: string): string {
  const match = /^mcp__[^_]+(?:_[^_]+)*__(.+)$/.exec(name);
  return match ? match[1] : name;
}

export function describeTool(name: string): { short: string; label: string; kind: ToolKind } {
  const short = shortToolName(name);
  const known = LABELS[short];
  return { short, label: known?.label ?? short, kind: known?.kind ?? "read" };
}
