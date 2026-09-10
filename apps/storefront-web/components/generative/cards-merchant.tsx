"use client";

/**
 * The merchant agent's presentation components — a different set from the shopper's
 * (`merchant_agent/enrichment.py`'s own `PRESENTATION_COMPONENTS`), overlapping only
 * on `suggestions`.
 *
 * `change_preview` is the one that carries the product argument: the agent has
 * DRAFTED a write, and the card shows the exact before/after plus whatever the
 * guardrails flagged. Nothing here applies anything — the approve button lives on
 * the operator page, and `apply_change` re-checks the approved set server-side.
 */

import type { ChangePreviewPayload, DigestPayload, MetricsPayload } from "@/lib/generative/types";
import { money } from "./format";

const KIND_LABELS: Record<string, string> = {
  low_stock: "库存偏低",
  slow_mover: "动销偏慢",
  order_issue: "订单异常",
  metric: "指标",
  pending_change: "待审改动",
  note: "备注",
};

function formatMetric(value: number, currency?: string | null): string {
  if (currency) return money(value, currency);
  return Number.isInteger(value) ? value.toLocaleString("en-US") : value.toFixed(1);
}

export function MetricsCard({ payload }: { payload: MetricsPayload }) {
  return (
    <div className="g-card">
      <div className="g-card-head">
        <b>{payload.title ?? "经营指标"}</b>
        {payload.period ? <span className="g-kind">{payload.period}</span> : <span className="g-kind">metrics</span>}
      </div>
      <div className="g-body">
        <div className="g-kv">
          {(payload.metrics ?? []).map((metric) => {
            const delta = metric.change_pct;
            return (
              <div className="g-metric" key={metric.metric}>
                <div className="g-metric-name">{metric.metric}</div>
                <div className="g-metric-val">
                  {formatMetric(metric.value, metric.currency)}
                  {typeof delta === "number" && delta !== 0 ? (
                    <span className="g-delta" data-dir={delta > 0 ? "up" : "down"}>
                      {delta > 0 ? "▲" : "▼"}
                      {Math.abs(delta).toFixed(1)}%
                    </span>
                  ) : null}
                </div>
                {metric.note ? (
                  <div style={{ fontSize: 10.5, color: "#8a8f99", marginTop: 3, lineHeight: 1.5 }}>
                    {metric.note}
                  </div>
                ) : null}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

export function DigestCard({ payload }: { payload: DigestPayload }) {
  return (
    <div className="g-card">
      <div className="g-card-head">
        <b>{payload.title ?? "今日待办"}</b>
        <span className="g-kind">digest</span>
      </div>
      <div className="g-body">
        {(payload.items ?? []).map((item, index) => (
          <div className="g-row" key={`${item.headline}-${index}`}>
            <div className="g-row-main">
              <div style={{ display: "flex", gap: 6, alignItems: "center", marginBottom: 2 }}>
                <span className="m-tag" data-tone={item.kind === "order_issue" ? undefined : "gray"}>
                  {KIND_LABELS[item.kind] ?? item.kind}
                </span>
                {item.ref_id ? (
                  <span style={{ fontSize: 10, color: "#a9aeb6", fontFamily: "var(--mono)" }}>{item.ref_id}</span>
                ) : null}
              </div>
              <div className="g-row-title">{item.headline}</div>
              {item.why_it_matters ? (
                <div style={{ fontSize: 11.5, color: "#7b808a", lineHeight: 1.6, marginTop: 2 }}>
                  {item.why_it_matters}
                </div>
              ) : null}
              {item.listing ? (
                <div style={{ fontSize: 11, color: "#8a8f99", marginTop: 3 }}>
                  {item.listing.title}
                  {typeof item.listing.stock === "number" ? ` · 库存 ${item.listing.stock}` : ""}
                  {typeof item.listing.price === "number" ? ` · ${money(item.listing.price)}` : ""}
                </div>
              ) : null}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

export function ChangePreviewCard({ payload }: { payload: ChangePreviewPayload }) {
  const change = payload.change;
  const marginBefore = change?.margin_before_pct;
  const marginAfter = change?.margin_after_pct;
  return (
    <div className="g-card">
      <div className="g-card-head">
        <b>{payload.headline ?? change?.summary ?? "待审改动"}</b>
        <span className="g-kind">change_preview</span>
      </div>
      <div className="g-body">
        <div style={{ display: "flex", gap: 6, alignItems: "center", marginBottom: 8 }}>
          <span className="m-tag" data-tone="gray">
            {change?.kind}
          </span>
          <span className="m-tag">{change?.status === "approved" ? "已批准" : "待审批"}</span>
          <span style={{ fontSize: 10.5, color: "#a9aeb6", fontFamily: "var(--mono)" }}>
            {payload.change_id}
          </span>
        </div>

        {(change?.items ?? []).map((item, index) => (
          <div className="g-diff" key={index} style={{ marginBottom: 6 }}>
            <div style={{ color: "#8a8f99", marginBottom: 2 }}>
              {item.target} · {item.field}
            </div>
            <span className="b">{String(item.before)}</span>
            {" → "}
            <span className="a">{String(item.after)}</span>
          </div>
        ))}

        {typeof marginBefore === "number" && typeof marginAfter === "number" ? (
          <div className="g-diff">
            <div style={{ color: "#8a8f99", marginBottom: 2 }}>毛利率</div>
            <span className="b">{marginBefore.toFixed(1)}%</span>
            {" → "}
            <span className={marginAfter >= marginBefore ? "a" : "b"} style={{ textDecoration: "none" }}>
              {marginAfter.toFixed(1)}%
            </span>
          </div>
        ) : null}

        {change?.guardrail_notes?.length ? (
          <ul className="g-list" style={{ marginTop: 8 }}>
            {change.guardrail_notes.map((note) => (
              <li key={note}>{note}</li>
            ))}
          </ul>
        ) : null}

        {payload.note ? (
          <div style={{ fontSize: 11.5, color: "#7b808a", marginTop: 8, lineHeight: 1.6 }}>{payload.note}</div>
        ) : null}

        <a
          href="/operator"
          target="_blank"
          rel="noreferrer"
          className="m-btn"
          data-variant="ghost"
          style={{ display: "block", textAlign: "center", marginTop: 10, padding: "8px 0", fontSize: 12.5 }}
        >
          去审批页确认 →
        </a>
      </div>
    </div>
  );
}
