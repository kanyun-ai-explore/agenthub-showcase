"use client";

/**
 * 教育场景的展示组件。
 *
 * `slide` / `exercise` 是特例：内容在课件区渲染（ClassroomApp 直接读卡片），对话流里只留
 * 一条很轻的提示。
 */

import { money } from "./format";

export interface CoursePlanPayload {
  title?: string;
  level?: string;
  sessions?: number;
  weeks?: number;
  price?: number;
  original_price?: number;
  highlights?: string[];
  note?: string;
}

export interface TrialSlotsPayload {
  title?: string;
  slots?: { slot_id: string; date: string; time: string; teacher?: string; seats_left?: number }[];
  note?: string;
}

export interface CorrectionPayload {
  title?: string;
  items?: {
    question: string;
    student_answer?: string;
    correct: boolean;
    where_wrong?: string;
    hint?: string;
  }[];
  summary?: string;
}

export interface ReportPayload {
  title?: string;
  week_of?: string;
  class_summary?: { total_attempts?: number; active_students?: number; accuracy?: number };
  knowledge_points?: {
    knowledge_point: string;
    attempts: number;
    accuracy: number;
    avg_duration_ms?: number;
    struggling?: boolean;
  }[];
  alerts?: { knowledge_point: string; consecutive_wrong: number; student_id?: string }[];
  data_quality?: { accepted_rows?: number; rejected_rows?: number };
}

const pct = (v?: number) => (typeof v === "number" ? `${Math.round(v * 100)}%` : "—");

export function CoursePlanCard({ payload }: { payload: CoursePlanPayload }) {
  return (
    <div className="g-card">
      <div className="g-card-head">
        <b>{payload.title ?? "课程方案"}</b>
        <span className="g-kind">course_plan</span>
      </div>
      <div className="g-body">
        <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginBottom: 10 }}>
          {payload.level ? <span className="m-tag">{payload.level}</span> : null}
          {payload.sessions ? <span className="m-tag" data-tone="gray">{payload.sessions} 节</span> : null}
          {payload.weeks ? <span className="m-tag" data-tone="gray">{payload.weeks} 周</span> : null}
        </div>

        {typeof payload.price === "number" ? (
          <div style={{ display: "flex", alignItems: "baseline", gap: 8, marginBottom: 10 }}>
            <span className="m-price" style={{ fontSize: 22 }}>
              {money(payload.price)}
            </span>
            {typeof payload.original_price === "number" && payload.original_price > payload.price ? (
              <span className="m-flash-was">{money(payload.original_price)}</span>
            ) : null}
          </div>
        ) : null}

        {payload.highlights?.length ? (
          <ul className="g-list" style={{ margin: 0 }}>
            {payload.highlights.map((h) => (
              <li key={h} className="g-pro">
                {h}
              </li>
            ))}
          </ul>
        ) : null}

        {payload.note ? (
          <div style={{ fontSize: 11.5, color: "#7b808a", marginTop: 9, lineHeight: 1.6 }}>{payload.note}</div>
        ) : null}
      </div>
    </div>
  );
}

export function TrialSlotsCard({ payload }: { payload: TrialSlotsPayload }) {
  return (
    <div className="g-card">
      <div className="g-card-head">
        <b>{payload.title ?? "可约试听"}</b>
        <span className="g-kind">trial_slots</span>
      </div>
      <div className="g-body">
        {(payload.slots ?? []).map((slot) => (
          <div className="g-row" key={slot.slot_id}>
            <div className="g-row-main">
              <div className="g-row-title">
                {slot.date} {slot.time}
              </div>
              <div style={{ fontSize: 11.5, color: "#8a8f99", marginTop: 2 }}>
                {slot.teacher ? `${slot.teacher} 老师` : ""}
                {typeof slot.seats_left === "number" ? ` · 剩 ${slot.seats_left} 个名额` : ""}
              </div>
            </div>
          </div>
        ))}
        {payload.note ? (
          <div style={{ fontSize: 11.5, color: "#7b808a", marginTop: 8, lineHeight: 1.6 }}>{payload.note}</div>
        ) : null}
      </div>
    </div>
  );
}

export function CorrectionCard({ payload }: { payload: CorrectionPayload }) {
  const items = payload.items ?? [];
  const right = items.filter((i) => i.correct).length;
  return (
    <div className="g-card">
      <div className="g-card-head">
        <b>{payload.title ?? "批改结果"}</b>
        <span className="g-kind">correction</span>
      </div>
      <div className="g-body">
        <div style={{ fontSize: 12, color: "#8a8f99", marginBottom: 8 }}>
          共 {items.length} 题，对 {right} 题
        </div>
        {items.map((item, i) => (
          <div className="g-row" key={i}>
            <span
              style={{
                width: 18,
                height: 18,
                borderRadius: 999,
                display: "grid",
                placeItems: "center",
                fontSize: 11,
                flex: "none",
                marginTop: 2,
                background: item.correct ? "#eaf8f1" : "#fdeeee",
                color: item.correct ? "#17864f" : "#b93b3b",
              }}
            >
              {item.correct ? "✓" : "✕"}
            </span>
            <div className="g-row-main">
              <div className="g-row-title" style={{ fontVariantNumeric: "tabular-nums" }}>
                {item.question}
              </div>
              {item.student_answer ? (
                <div style={{ fontSize: 11.5, color: "#8a8f99", marginTop: 2 }}>你写的：{item.student_answer}</div>
              ) : null}
              {item.where_wrong ? (
                <div style={{ fontSize: 11.5, color: "#b93b3b", marginTop: 3, lineHeight: 1.55 }}>
                  {item.where_wrong}
                </div>
              ) : null}
              {item.hint ? (
                <div style={{ fontSize: 11.5, color: "#4b62c9", marginTop: 3, lineHeight: 1.55 }}>
                  提示：{item.hint}
                </div>
              ) : null}
            </div>
          </div>
        ))}
        {payload.summary ? (
          <div style={{ fontSize: 12, color: "#4f5560", marginTop: 9, lineHeight: 1.65 }}>{payload.summary}</div>
        ) : null}
      </div>
    </div>
  );
}

export function ReportCard({ payload }: { payload: ReportPayload }) {
  const summary = payload.class_summary ?? {};
  return (
    <div className="g-card">
      <div className="g-card-head">
        <b>{payload.title ?? "班级学情周报"}</b>
        <span className="g-kind">report</span>
      </div>
      <div className="g-body">
        {payload.week_of ? (
          <div style={{ fontSize: 11.5, color: "#8a8f99", marginBottom: 9 }}>{payload.week_of} 当周</div>
        ) : null}

        <div className="g-kv" style={{ gridTemplateColumns: "repeat(3, 1fr)" }}>
          <div className="g-metric">
            <div className="g-metric-name">答题量</div>
            <div className="g-metric-val">{summary.total_attempts ?? "—"}</div>
          </div>
          <div className="g-metric">
            <div className="g-metric-name">活跃学生</div>
            <div className="g-metric-val">{summary.active_students ?? "—"}</div>
          </div>
          <div className="g-metric">
            <div className="g-metric-name">正确率</div>
            <div className="g-metric-val">{pct(summary.accuracy)}</div>
          </div>
        </div>

        {payload.knowledge_points?.length ? (
          <div style={{ marginTop: 12 }}>
            {payload.knowledge_points.map((kp) => (
              <div className="g-row" key={kp.knowledge_point}>
                <div className="g-row-main">
                  <div className="g-row-title">
                    {kp.knowledge_point}
                    {kp.struggling ? (
                      <span className="m-tag" style={{ marginLeft: 6 }}>
                        疑难
                      </span>
                    ) : null}
                  </div>
                  <div style={{ fontSize: 11, color: "#8a8f99", marginTop: 2 }}>
                    {kp.attempts} 题
                    {typeof kp.avg_duration_ms === "number"
                      ? ` · 平均 ${(kp.avg_duration_ms / 1000).toFixed(1)}s`
                      : ""}
                  </div>
                </div>
                <div
                  style={{
                    fontSize: 14,
                    fontWeight: 700,
                    color: kp.accuracy < 0.6 ? "#b93b3b" : "#17864f",
                    fontVariantNumeric: "tabular-nums",
                  }}
                >
                  {pct(kp.accuracy)}
                </div>
              </div>
            ))}
          </div>
        ) : null}

        {payload.alerts?.length ? (
          <div style={{ marginTop: 10 }}>
            <div style={{ fontSize: 11.5, fontWeight: 600, marginBottom: 4 }}>需要关注</div>
            {payload.alerts.map((a, i) => (
              <div key={i} style={{ fontSize: 11.5, color: "#b93b3b", lineHeight: 1.7 }}>
                {a.student_id ? `${a.student_id} · ` : ""}
                {a.knowledge_point} 连续错 {a.consecutive_wrong} 次
              </div>
            ))}
          </div>
        ) : null}

        {payload.data_quality ? (
          <div style={{ fontSize: 10.5, color: "#a9aeb6", marginTop: 10, fontFamily: "var(--mono)" }}>
            数据质量：采纳 {payload.data_quality.accepted_rows ?? 0} 行
            {payload.data_quality.rejected_rows ? `，丢弃 ${payload.data_quality.rejected_rows} 行` : "，无丢弃"}
          </div>
        ) : null}
      </div>
    </div>
  );
}

/** 课件页在对话流里只留一条痕迹，真正的呈现在课件区。 */
export function SlideCue({ payload }: { payload: { title?: string; prompt?: string } }) {
  return (
    <div className="m-tool">
      <b>课件</b>
      {payload.title ?? payload.prompt ?? ""}
    </div>
  );
}
