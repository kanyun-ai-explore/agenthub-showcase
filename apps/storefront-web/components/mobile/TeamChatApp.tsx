"use client";

/**
 * 「团队群」：一段按脚本播放的群聊动画，界面照 Slack 画（原型）。
 *
 * 这块界面不能操作，也不接任何后端：它只把 `frameAt` 算出的一帧画出来，没有 `fetch`、没有会话。
 * 它画的是目标形态——agent 接进团队的 Slack 工作区之后我们希望它怎样工作——所以是脚本，不是演示。
 * 页面上三处写明这一点：频道头下的置顶条、输入框、右栏。
 *
 * 两种东西不要混：Slack 的界面元素（消息、:eyes:、进度状态、Stop、消息下面的卡片和按钮）按 Slack 的
 * 样子画；「回放旁注」和成员去点按钮的触点是回放加的旁白，用虚线和站点绿，和 Slack 的界面分开。
 */

import { Fragment, useEffect, useRef, type ReactNode } from "react";
import type { Frame, Row, TapView } from "@/lib/team-chat/replay";
import { BOT_NAME, HUMANS, type Block, type HumanId, type ReplayScript } from "@/lib/team-chat/script";

const TOKEN = /(\*\*[^*]+\*\*|`[^`]+`|\[\[[^\]]+\]\]|<@(?:a|b|bot)>)/g;

function inline(text: string): ReactNode[] {
  return text
    .split(TOKEN)
    .filter(Boolean)
    .map((part, i) => {
      if (part.startsWith("**")) return <b key={i}>{part.slice(2, -2)}</b>;
      if (part.startsWith("`")) return <code key={i}>{part.slice(1, -1)}</code>;
      if (part.startsWith("[[")) {
        return (
          <span className="tc-link" key={i}>
            {part.slice(2, -2)}
          </span>
        );
      }
      if (part.startsWith("<@")) {
        const who = part.slice(2, -1);
        return (
          <span className="tc-mention" key={i}>
            @{who === "bot" ? BOT_NAME : HUMANS[who as HumanId].name}
          </span>
        );
      }
      return <Fragment key={i}>{part}</Fragment>;
    });
}

/** 剧本文字里的那几种标记（见 `script.ts` 的 `Step`）。 */
function Rich({ text }: { text: string }) {
  return (
    <div className="tc-text">
      {text.split("\n").map((line, i) =>
        line.length > 2 && line.startsWith("_") && line.endsWith("_") ? (
          <div className="tc-em" key={i}>
            {line.slice(1, -1)}
          </div>
        ) : (
          <div key={i}>{inline(line)}</div>
        ),
      )}
    </div>
  );
}

/** 成员去点按钮的触点：回放加的，Slack 里没有。 */
function TapDot({ tap }: { tap: TapView | null }) {
  if (!tap || tap.phase === "idle") return null;
  return (
    <span className="tc-tap" data-phase={tap.phase} aria-hidden="true">
      <span className="tc-tap-dot" />
      <span className="tc-tap-who">{HUMANS[tap.by].name}</span>
    </span>
  );
}

function BotAvatar() {
  return (
    <div className="tc-avatar" data-who="bot">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <rect x="5" y="8" width="14" height="10" rx="3" />
        <path d="M12 8V5M9.5 13h.01M14.5 13h.01" />
      </svg>
    </div>
  );
}

function Fields({ rows }: { rows: [string, string][] }) {
  return (
    <dl className="tc-fields">
      {rows.map(([label, value]) => (
        <div key={label}>
          <dt>{label}</dt>
          <dd>{value}</dd>
        </div>
      ))}
    </dl>
  );
}

/** bot 消息下面的卡片：回执、PR 链接的展开、确认卡。 */
function BlockCard({ block, row }: { block: Block; row: Extract<Row, { kind: "bot" }> }) {
  if (block.kind === "pr") {
    return (
      <div className="tc-block" data-kind="pr">
        <div className="tc-block-meta">
          {block.repo} · PR {block.number}
        </div>
        <div className="tc-block-title tc-link">{block.title}</div>
        <div className="tc-checks" data-passed={row.passed}>
          {row.passed ? <span className="tc-check-mark">✓</span> : <span className="tc-spin" />}
          {row.passed ? "3 项检查通过" : "检查运行中"}
        </div>
      </div>
    );
  }
  if (block.kind === "receipt") {
    return (
      <div className="tc-block" data-kind="receipt">
        <div className="tc-block-title">
          <span className="tc-check-mark">✓</span>
          {block.title}
        </div>
        <Fields rows={block.rows} />
        {block.undo ? (
          <div className="tc-actions">
            <span className="tc-btn">{block.undo}</span>
          </div>
        ) : null}
      </div>
    );
  }
  const pressed = row.tap?.phase === "press";
  return (
    <div className="tc-block" data-kind="confirm" data-approved={row.approved}>
      <div className="tc-block-title">{block.title}</div>
      <Fields rows={block.rows} />
      {row.approved ? (
        <div className="tc-approved">
          <span className="tc-check-mark">✓</span>
          {HUMANS[block.tap.by].name} 已批准 · {block.clock}
        </div>
      ) : (
        <div className="tc-actions">
          <span className="tc-btn" data-style="primary" data-pressed={pressed}>
            {block.approve}
            <TapDot tap={row.tap} />
          </span>
          <span className="tc-btn">{block.deny}</span>
        </div>
      )}
    </div>
  );
}

function renderRow(row: Row) {
  switch (row.kind) {
    case "note":
      return (
        <div className="tc-note-row" key={row.step.id}>
          <div className="tc-note" data-tone={row.decided ? row.step.tone : "listening"}>
            <span className="tc-note-tag">回放旁注</span>
            {row.decided ? (
              <span>{row.step.text}</span>
            ) : (
              <span className="tc-dots">
                agent 在旁听
                <i />
                <i />
                <i />
              </span>
            )}
          </div>
        </div>
      );
    case "status": {
      const pressed = row.tap?.phase === "press";
      return (
        <div className="tc-status" key={row.step.id} data-pressed={pressed}>
          <span className="tc-spin" />
          <span className="tc-status-text">{row.step.text}</span>
          <span className="tc-btn" data-pressed={pressed}>
            <span className="tc-stop-mark" />
            Stop
            <TapDot tap={row.tap} />
          </span>
        </div>
      );
    }
    case "bot":
    case "message": {
      const who = row.kind === "message" ? HUMANS[row.step.who] : null;
      return (
        <div className="tc-msg" key={row.step.id} data-thread={row.step.thread !== undefined}>
          {who ? (
            <div className="tc-avatar" style={{ background: who.color }}>
              {who.initial}
            </div>
          ) : (
            <BotAvatar />
          )}
          <div className="tc-body">
            <div className="tc-name">
              <b>{who ? who.name : BOT_NAME}</b>
              {who ? null : <span className="tc-app-badge">APP</span>}
              <time>{row.step.clock}</time>
            </div>
            <Rich text={row.step.text} />
            {row.kind === "bot" && row.step.block ? <BlockCard block={row.step.block} row={row} /> : null}
            {row.kind === "message" && row.eyes ? (
              <div className="tc-reactions">
                <span className="tc-reaction">
                  <span aria-label="eyes">👀</span>1
                </span>
              </div>
            ) : null}
            {row.replies > 0 ? <div className="tc-replies">{row.replies} 条回复</div> : null}
          </div>
        </div>
      );
    }
  }
}

export function TeamChatApp({
  script,
  frame,
  playing,
  reduced,
}: {
  script: ReplayScript;
  frame: Frame;
  playing: boolean;
  reduced: boolean;
}) {
  const listRef = useRef<HTMLDivElement>(null);
  const lastHeight = useRef(0);

  // 内容长高就跟到底。只在高度变了的时候滚，免得每帧打断上一次平滑滚动。
  useEffect(() => {
    const el = listRef.current;
    if (!el || el.scrollHeight === lastHeight.current) return;
    lastHeight.current = el.scrollHeight;
    el.scrollTo({ top: el.scrollHeight, behavior: reduced ? "auto" : "smooth" });
  });

  return (
    <div className="m-app tc-app" data-playing={playing}>
      <div className="tc-top">
        <div className="m-status">
          <span>9:41</span>
          <span className="m-status-right">
            <span style={{ fontSize: 10.5, fontWeight: 700 }}>5G</span>
            <span className="m-battery" />
          </span>
        </div>
        <div className="tc-head">
          <span className="tc-back" aria-hidden="true">
            ‹
          </span>
          <div className="tc-head-main">
            <b>
              <span className="tc-hash">#</span>
              {script.channel}
            </b>
            <span>团队群 · 脚本原型</span>
          </div>
        </div>
      </div>
      <div className="tc-pin">
        <b>脚本原型，不能操作</b>
        <span>目标形态示意；人名、服务和读数都是编的</span>
      </div>
      <div className="tc-list" ref={listRef}>
        {frame.rows.map(renderRow)}
      </div>
      <div className="tc-typing" aria-hidden={frame.typing === null}>
        {frame.typing ? (
          <span className="tc-dots">
            <i />
            <i />
            <i />
            {HUMANS[frame.typing].name} 正在输入
          </span>
        ) : null}
      </div>
      <div className="tc-composer" aria-disabled="true">
        <span className="tc-plus">+</span>
        <span>脚本原型，不能发消息</span>
      </div>
    </div>
  );
}
