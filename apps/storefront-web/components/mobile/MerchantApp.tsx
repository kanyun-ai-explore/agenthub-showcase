"use client";

/**
 * The merchant phone app — the second case, and the one that makes the approval
 * gate tangible.
 *
 * The interesting surface here is 待审: the agent drafts writes with its `stage_*`
 * tools, the stdio server mirrors them to `/api/changes/mirror`, and this list is
 * that queue. Approving here is the ONLY thing that lets the agent's `apply_change`
 * succeed — it re-reads the approved set from this app before every apply and never
 * caches it. So the demo is: ask for a promotion → watch the change appear → tap
 * 批准 → tell the agent to apply it.
 *
 * `/operator` remains the same queue on a desktop surface; both read one store.
 */

import { useCallback, useEffect, useState } from "react";
import type { Conversation } from "@/components/agent/useAgentConversation";
import type { PendingChange } from "@/lib/backend/types-merchant";
import { SHOWCASE_MERCHANT_ID } from "@/lib/showcase/merchant";
import { IconChevron, IconGrid, IconHome, IconSparkle } from "./icons";
import { AgentSheet } from "./AgentSheet";

type Tab = "home" | "changes";

function StatusBar() {
  return (
    <div className="m-status">
      <span>9:41</span>
      <span className="m-status-right">
        <span style={{ fontSize: 10.5, fontWeight: 700 }}>5G</span>
        <span className="m-battery" />
      </span>
    </div>
  );
}

const KIND_LABELS: Record<string, string> = {
  listing_update: "商品改动",
  price_update: "调价",
  inventory_action: "库存操作",
  promotion: "促销",
  campaign: "营销活动",
};

function ChangeRow({
  change,
  busy,
  onApprove,
  onDiscard,
}: {
  change: PendingChange;
  busy: boolean;
  onApprove: (key: string) => void;
  onDiscard: (key: string) => void;
}) {
  return (
    <div style={{ padding: "13px 14px", borderBottom: "1px solid var(--m-line)" }}>
      <div style={{ display: "flex", gap: 6, alignItems: "center", marginBottom: 5 }}>
        <span className="m-tag" data-tone="gray">
          {KIND_LABELS[change.kind] ?? change.kind}
        </span>
        <span className="m-tag">{change.approved ? "已批准" : "待审批"}</span>
        <span style={{ fontSize: 10, color: "#a9aeb6", fontFamily: "var(--mono)", marginLeft: "auto" }}>
          {change.change_id}
        </span>
      </div>
      <div style={{ fontSize: 13, fontWeight: 560, lineHeight: 1.45 }}>{change.summary}</div>

      {(change.items ?? []).slice(0, 3).map((item, index) => (
        <div className="g-diff" key={index} style={{ marginTop: 6 }}>
          <div style={{ color: "#8a8f99", marginBottom: 2 }}>
            {item.target} · {item.field}
          </div>
          <span className="b">{String(item.before)}</span>
          {" → "}
          <span className="a">{String(item.after)}</span>
        </div>
      ))}

      {change.guardrail_notes?.length ? (
        <ul className="g-list" style={{ marginTop: 6 }}>
          {change.guardrail_notes.slice(0, 2).map((note) => (
            <li key={note}>{note}</li>
          ))}
        </ul>
      ) : null}

      {change.approved ? (
        <div style={{ fontSize: 11.5, color: "#16a06b", marginTop: 9 }}>
          已批准 —— 现在让 Agent 执行 <code>apply_change</code> 就会真正生效
        </div>
      ) : (
        <div style={{ display: "flex", gap: 8, marginTop: 10 }}>
          <button
            type="button"
            className="m-btn"
            disabled={busy}
            style={{ flex: 1, padding: "8px 0", fontSize: 13 }}
            onClick={() => onApprove(change.mirror_key)}
          >
            批准
          </button>
          <button
            type="button"
            className="m-btn"
            data-variant="ghost"
            disabled={busy}
            style={{ flex: "none", padding: "8px 18px", fontSize: 13 }}
            onClick={() => onDiscard(change.mirror_key)}
          >
            驳回
          </button>
        </div>
      )}
    </div>
  );
}

export function MerchantApp({
  conversation,
  openers,
  settleToken,
}: {
  conversation: Conversation;
  openers: string[];
  settleToken: number;
}) {
  const [tab, setTab] = useState<Tab>("home");
  const [sheet, setSheet] = useState(false);
  const [changes, setChanges] = useState<PendingChange[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [toast, setToast] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const res = await fetch(`/api/changes/pending?merchantId=${encodeURIComponent(SHOWCASE_MERCHANT_ID)}`);
      const data = (await res.json()) as { changes?: PendingChange[] };
      setChanges(data.changes ?? []);
    } catch {
      setChanges([]);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh, settleToken]);

  useEffect(() => {
    if (!toast) return;
    const timer = setTimeout(() => setToast(null), 2200);
    return () => clearTimeout(timer);
  }, [toast]);

  const act = async (key: string, action: "approve" | "discard") => {
    setBusy(true);
    try {
      await fetch(`/api/changes/${encodeURIComponent(key)}/${action}`, { method: "POST" });
      await refresh();
      setToast(action === "approve" ? "已批准，Agent 现在可以执行了" : "已驳回");
    } finally {
      setBusy(false);
    }
  };

  const pending = (changes ?? []).filter((c) => !c.approved);

  return (
    <div className="m-app" style={{ ["--acc" as string]: "#1e6bff", ["--acc-2" as string]: "#00b2ff", ["--acc-soft" as string]: "rgba(30,107,255,0.1)" }}>
      <StatusBar />

      {tab === "home" ? (
        <>
          <div className="m-head" style={{ paddingBottom: 30 }}>
            <div className="m-head-top">
              <div className="m-logo">
                ACME <small>商家工作台</small>
              </div>
            </div>
          </div>
          <div className="m-body" style={{ marginTop: -18 }}>
            <div className="m-banner" style={{ background: "linear-gradient(122deg,#123a7a 0%,#1e6bff 58%,#00b2ff 100%)" }}>
              <h3>今天的店，问一句就知道</h3>
              <p>经营快照、库存告警、滞销盘点，以及调价和促销草案 —— 都由 Agent 拟好，你只做同意或驳回。</p>
              <span className="m-banner-cta">点底部中间开始 →</span>
            </div>

            <div className="m-sec">
              <h3>待你处理</h3>
              <span className="m-sec-more">{pending.length} 项待审批</span>
            </div>
            <div className="m-panel">
              <button type="button" className="m-row" onClick={() => setTab("changes")}>
                <div className="m-row-main">
                  <div className="m-row-title">待审改动</div>
                  <div className="m-row-sub">
                    {changes === null ? "加载中…" : pending.length > 0 ? `${pending.length} 项等待批准` : "暂时没有待审改动"}
                  </div>
                </div>
                <IconChevron />
              </button>
              <a className="m-row" href="/operator" target="_blank" rel="noreferrer">
                <div className="m-row-main">
                  <div className="m-row-title">在电脑上审批</div>
                  <div className="m-row-sub">/operator · 同一个队列</div>
                </div>
                <IconChevron />
              </a>
            </div>

            <div className="m-sec">
              <h3>可以这样问</h3>
            </div>
            <div className="m-panel" style={{ padding: "10px 12px" }}>
              <div className="m-openers" style={{ padding: 0 }}>
                {openers.map((text) => (
                  <button
                    key={text}
                    type="button"
                    className="m-opener"
                    onClick={() => {
                      setSheet(true);
                      conversation.send(text);
                    }}
                  >
                    <i>›</i>
                    {text}
                  </button>
                ))}
              </div>
            </div>

            <div className="m-sec">
              <h3>店铺</h3>
            </div>
            <div className="m-panel" style={{ padding: "14px" }}>
              <div style={{ fontSize: 15, fontWeight: 680 }}>ACME Outdoors</div>
              <div style={{ fontSize: 11.5, color: "#8a8f99", marginTop: 3 }}>
                merchant_id · <code>{SHOWCASE_MERCHANT_ID}</code>
              </div>
              <div className="m-specs" style={{ marginTop: 10 }}>
                <div className="m-spec">
                  <b>身份</b>
                  <span>固定在 agent.yaml env（CMA_MERCHANT_ID / CMA_OPERATOR），会话因此能命中预热池</span>
                </div>
                <div className="m-spec">
                  <b>写操作</b>
                  <span>全部先落待审，批准后才执行</span>
                </div>
                <div className="m-spec">
                  <b>工具</b>
                  <span>22 个商家 MCP 工具</span>
                </div>
              </div>
            </div>
          </div>
        </>
      ) : (
        <>
          <div className="m-head" style={{ paddingBottom: 14 }}>
            <div className="m-head-top">
              <div className="m-logo">待审改动</div>
            </div>
          </div>
          <div className="m-body">
            <div className="m-panel" style={{ marginTop: 6, padding: 0 }}>
              {changes === null ? (
                <div className="m-empty">加载中…</div>
              ) : changes.length === 0 ? (
                <div className="m-empty">
                  <div className="m-empty-ico">📝</div>
                  还没有改动
                  <div style={{ marginTop: 6 }}>让 Agent 拟一个促销或调价，它会出现在这里</div>
                </div>
              ) : (
                changes.map((change) => (
                  <ChangeRow
                    key={change.mirror_key}
                    change={change}
                    busy={busy}
                    onApprove={(k) => void act(k, "approve")}
                    onDiscard={(k) => void act(k, "discard")}
                  />
                ))
              )}
            </div>
          </div>
        </>
      )}

      {toast ? <div className="m-toast">{toast}</div> : null}

      {sheet ? (
        <AgentSheet
          conversation={conversation}
          agentName="ACME 商家助手"
          openers={openers}
          onClose={() => {
            setSheet(false);
            void refresh();
          }}
          actions={{ onPickSuggestion: (text) => conversation.send(text) }}
        />
      ) : null}

      <div className="m-tabs" style={{ gridTemplateColumns: "repeat(3, 1fr)" }}>
        <button type="button" className="m-tab" data-active={tab === "home"} onClick={() => setTab("home")}>
          <IconHome active={tab === "home"} />
          工作台
        </button>
        <button
          type="button"
          className="m-tab m-tab-ai"
          onClick={() => {
            setSheet(true);
            conversation.start();
          }}
        >
          <span className="m-tab-ai-orb">
            <IconSparkle />
          </span>
          <span>AI 助手</span>
        </button>
        <button type="button" className="m-tab" data-active={tab === "changes"} onClick={() => setTab("changes")}>
          <span style={{ position: "relative" }}>
            <IconGrid active={tab === "changes"} />
            {pending.length > 0 ? <span className="m-tab-badge">{pending.length}</span> : null}
          </span>
          待审
        </button>
      </div>
    </div>
  );
}
