"use client";

/**
 * 把一个展示信封分发到对应的卡片。
 *
 * default 分支是有用的，不是防御性样板：这里原来是白名单，漏掉的组件会被静默丢弃——
 * 正文和工具轨迹都正常，看起来就像 agent 没想展示（merchant 的 metrics 卡就这么丢了
 * 一天）。现在 `displayed: true` 的都渲染，没有对应组件就显示成「还没实现」。
 */

import {
  CheckoutCard,
  ComparisonCard,
  GuideCard,
  OrderStatusCard,
  PlanCard,
  ProductsCard,
  SuggestionsCard,
  type CardActions,
} from "./cards-shopping";
import { ChangePreviewCard, DigestCard, MetricsCard } from "./cards-merchant";
import { CorrectionCard, CoursePlanCard, ReportCard, SlideCue, TrialSlotsCard } from "./cards-course";

export type { CardActions };

export function GenerativeCard({
  component,
  payload,
  actions = {},
  disabled,
}: {
  component: string;
  payload: unknown;
  actions?: CardActions;
  disabled?: boolean;
}) {
  switch (component) {
    case "products":
      return <ProductsCard payload={payload as never} actions={actions} />;
    case "comparison":
      return <ComparisonCard payload={payload as never} />;
    case "plan":
      return <PlanCard payload={payload as never} actions={actions} />;
    case "guide":
      return <GuideCard payload={payload as never} actions={actions} />;
    case "order_status":
      return <OrderStatusCard payload={payload as never} />;
    case "checkout":
      return <CheckoutCard payload={payload as never} />;
    case "metrics":
      return <MetricsCard payload={payload as never} />;
    case "digest":
      return <DigestCard payload={payload as never} />;
    case "change_preview":
      return <ChangePreviewCard payload={payload as never} />;
    case "course_plan":
      return <CoursePlanCard payload={payload as never} />;
    case "trial_slots":
      return <TrialSlotsCard payload={payload as never} />;
    case "correction":
      return <CorrectionCard payload={payload as never} />;
    case "report":
      return <ReportCard payload={payload as never} />;
    case "slide":
    case "exercise":
      return <SlideCue payload={payload as never} />;
    case "suggestions": {
      const { suggestions } = (payload ?? {}) as { suggestions?: string[] };
      return (
        <SuggestionsCard
          suggestions={suggestions ?? []}
          onPick={actions.onPickSuggestion}
          disabled={disabled}
        />
      );
    }
    default:
      return (
        <div className="g-card">
          <div className="g-card-head">
            <b>组件 “{component}” 还没有渲染实现</b>
            <span className="g-kind">unknown</span>
          </div>
          <div className="g-body">
            <div style={{ fontSize: 11.5, color: "#7b808a", lineHeight: 1.6, marginBottom: 6 }}>
              Agent 返回了这个组件，但前端没有对应的卡片。数据在下面，加一个渲染器就能显示 —— 它不会被悄悄丢掉。
            </div>
            <pre className="g-diff" style={{ margin: 0, whiteSpace: "pre-wrap", maxHeight: 160, overflow: "auto" }}>
              {JSON.stringify(payload, null, 2).slice(0, 1200)}
            </pre>
          </div>
        </div>
      );
  }
}
