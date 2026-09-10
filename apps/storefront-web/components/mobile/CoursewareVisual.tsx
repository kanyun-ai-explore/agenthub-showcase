"use client";

/**
 * 课件里的教具图形。全部手绘 SVG/DOM，不用图片资源。
 *
 * 十格阵是一年级凑十法的标准教具：两行五格，满 10 一眼看出来。做成组件而不是图片，
 * 是因为 agent 会换数字——`present_slide` 指到哪一页，点子就重排到哪一页的数。
 */

import type { Visual } from "@/lib/course/types";

/** 实物图：最直观的一种，导入和低年级优先。emoji 由 agent 现挑。 */
function Objects({ emoji, groups }: { emoji: string; groups: number[] }) {
  return (
    <div className="cw-objs">
      {groups.map((n, gi) => (
        <div className="cw-obj-group" key={gi}>
          <div className="cw-obj-items">
            {Array.from({ length: Math.min(n, 20) }, (_, i) => (
              <span key={i} style={{ animationDelay: `${(gi * 10 + i) * 0.045}s` }}>
                {emoji}
              </span>
            ))}
          </div>
          <b>{n}</b>
        </div>
      ))}
    </div>
  );
}

function TenFrame({ count, filledLabel }: { count: number; filledLabel?: string }) {
  const cells = Array.from({ length: 10 }, (_, i) => i < count);
  const overflow = Math.max(0, count - 10);
  return (
    <div className="cw-frame">
      <div className="cw-grid">
        {cells.map((filled, i) => (
          <span key={i} className="cw-cell" data-filled={filled} />
        ))}
      </div>
      {overflow > 0 ? (
        <div className="cw-overflow">
          {Array.from({ length: overflow }, (_, i) => (
            <span key={i} className="cw-cell" data-filled="true" data-loose="true" />
          ))}
        </div>
      ) : null}
      <div className="cw-frame-label">
        {filledLabel ? <span>{filledLabel}</span> : null}
        <b>{count}</b>
      </div>
    </div>
  );
}

export function CoursewareVisual({ visual }: { visual: Visual }) {
  if (visual.type === "objects") {
    return (
      <div className="cw-visual">
        <Objects emoji={visual.emoji || "⭐"} groups={visual.groups ?? []} />
      </div>
    );
  }

  if (visual.type === "ten_frame") {
    return (
      <div className="cw-visual cw-frames">
        {visual.frames.map((n, i) =>
          n === 0 && !(visual.labels?.[i]) ? null : (
            <TenFrame key={i} count={n} filledLabel={visual.labels?.[i]} />
          ),
        )}
      </div>
    );
  }

  if (visual.type === "number_bond") {
    return (
      <div className="cw-visual">
        <div className="cw-bond">
          <span className="cw-bond-whole">{visual.whole}</span>
          <svg viewBox="0 0 120 44" className="cw-bond-legs" aria-hidden>
            <path d="M60 2 L18 42M60 2 L102 42" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
          </svg>
          <div className="cw-bond-parts">
            {visual.parts.map((p, i) => (
              <span key={i} className="cw-bond-part">
                {p}
              </span>
            ))}
          </div>
        </div>
        {visual.caption ? <div className="cw-caption">{visual.caption}</div> : null}
      </div>
    );
  }

  if (visual.type === "steps") {
    return (
      <div className="cw-visual cw-steps">
        {visual.steps.map((step, i) => (
          <div className="cw-step" key={i}>
            <span className="cw-step-expr">{step}</span>
            {visual.captions?.[i] ? <span className="cw-step-cap">{visual.captions[i]}</span> : null}
            {i < visual.steps.length - 1 ? <span className="cw-step-arrow">↓</span> : null}
          </div>
        ))}
      </div>
    );
  }

  return null;
}
