"use client";

/**
 * The agent, as a bottom sheet inside the phone.
 *
 * Deliberate choices, each one a lesson paid for:
 *
 * • The composer is NOT disabled while the sandbox starts. Typing is accepted and
 *   the text is sent the moment the session is ready. A dead input box with
 *   "starting…" above it is the single worst first impression this demo can make.
 * • The state line says which of three different waits you are in — creating,
 *   sandbox starting (with a second counter), or Agent Recovery — because they
 *   take different amounts of time and mean different things.
 * • Tool chips stream in before any reply text. On a real turn the model wrote 662
 *   reasoning deltas before its first reply character; without the trace the sheet
 *   would sit blank for most of the turn.
 * • Example prompts are dashed outline chips, visually unlike the pill-shaped
 *   suggestion chips the agent itself produces via `present_suggestions`. Page copy
 *   must not impersonate agent output.
 */

import { useEffect, useRef, useState } from "react";
import { GenerativeCard, type CardActions } from "@/components/generative";
import type { Conversation, Message, TraceItem } from "@/components/agent/useAgentConversation";
import { IconSend } from "./icons";

function StateLine({ conversation }: { conversation: Conversation }) {
  const { phase, busy, elapsed } = conversation;
  if (phase === "unconfigured") return <span>未接入控制面</span>;
  if (phase === "error") return <span>{conversation.error ?? "出错了"}</span>;
  if (phase === "creating") return <span>正在创建会话…</span>;
  if (phase === "starting") return <span>沙箱启动中 · {elapsed}s</span>;
  if (phase === "reviving") return <span>会话恢复中 · {elapsed}s</span>;
  if (busy) return <span>正在处理…</span>;
  if (phase === "ready") return <span>已就绪</span>;
  return <span>点一句开始</span>;
}

function tone(conversation: Conversation): "live" | "wait" | "off" {
  if (conversation.phase === "ready") return "live";
  if (conversation.phase === "unconfigured" || conversation.phase === "error") return "off";
  return "wait";
}

function Thinking({ text }: { text: string }) {
  const [open, setOpen] = useState(false);
  if (!text) return null;
  return (
    <div>
      <button type="button" className="m-tool" onClick={() => setOpen((v) => !v)}>
        <span className="m-typing">
          <i />
          <i />
          <i />
        </span>
        <b>思考中</b>
        {open ? "收起" : "展开"}
      </button>
      {open ? (
        <div
          style={{
            fontSize: 11,
            color: "#8a8f99",
            lineHeight: 1.65,
            background: "rgba(20,24,32,0.035)",
            borderRadius: 10,
            padding: "8px 10px",
            marginTop: 6,
            maxHeight: 150,
            overflowY: "auto",
            whiteSpace: "pre-wrap",
          }}
        >
          {text}
        </div>
      ) : null}
    </div>
  );
}

/** Consecutive calls to the same tool collapse into one chip with a count. A real
 * turn calls `search_products` eight times in a row; eight identical chips is a
 * wall of noise that hides the two interesting calls around it. */
function groupTrace(trace: readonly TraceItem[]): (TraceItem & { count: number })[] {
  const groups: (TraceItem & { count: number })[] = [];
  for (const item of trace) {
    const last = groups[groups.length - 1];
    if (last && last.label === item.label) {
      last.count += 1;
      last.done = last.done && item.done;
    } else {
      groups.push({ id: item.id, label: item.label, kind: item.kind, count: 1, done: item.done });
    }
  }
  return groups;
}

function AgentMessage({
  message,
  actions,
  disabled,
}: {
  message: Extract<Message, { role: "agent" }>;
  actions: CardActions;
  disabled: boolean;
}) {
  const hasBubble = message.text.length > 0 || (!message.streaming && message.cards.length === 0);
  const groups = groupTrace(message.trace);
  return (
    <>
      {groups.length > 0 ? (
        <div style={{ display: "flex", flexWrap: "wrap", gap: 5 }}>
          {groups.map((item) => (
            <span className="m-tool" key={item.id}>
              {item.done ? "✓" : <span className="m-spinner" style={{ borderTopColor: "#6e8bff", borderColor: "rgba(110,139,255,0.3)", width: 10, height: 10 }} />}
              <b>{item.label}</b>
              {item.count > 1 ? `×${item.count}` : null}
            </span>
          ))}
        </div>
      ) : null}

      {message.streaming && message.thinking && !message.text ? <Thinking text={message.thinking} /> : null}

      {message.cards.map((card) => (
        <GenerativeCard
          key={card.id}
          component={card.component}
          payload={card.payload}
          actions={actions}
          disabled={disabled}
        />
      ))}

      {hasBubble ? (
        <div className="m-msg" data-role="agent">
          <div className="m-bubble">
            {message.text || (message.failed ? "这一轮没有返回内容。" : "…")}
            {message.streaming && message.text ? <span className="m-caret" /> : null}
          </div>
        </div>
      ) : null}

      {message.streaming && !message.text && message.trace.length === 0 && !message.thinking ? (
        <div className="m-msg" data-role="agent">
          <div className="m-bubble">
            <span className="m-typing">
              <i />
              <i />
              <i />
            </span>
          </div>
        </div>
      ) : null}
    </>
  );
}

export function AgentSheet({
  conversation,
  agentName,
  openers,
  actions,
  onClose,
}: {
  conversation: Conversation;
  agentName: string;
  openers: string[];
  actions: CardActions;
  onClose: () => void;
}) {
  const [draft, setDraft] = useState("");
  const threadRef = useRef<HTMLDivElement>(null);
  const { messages, busy, phase } = conversation;

  // Follow the tail. `messages` is the dep on purpose — streaming mutates the last
  // message in place, and that is exactly when the thread needs to scroll.
  useEffect(() => {
    const el = threadRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages]);

  const blocked = phase === "unconfigured" || phase === "error";

  const submit = (text: string) => {
    if (!text.trim() || busy || blocked) return;
    conversation.send(text);
    setDraft("");
  };

  return (
    <>
      <div className="m-scrim" onClick={onClose} />
      <div className="m-sheet">
        <div className="m-sheet-head">
          <div className="m-sheet-grip" />
          <div className="m-sheet-avatar">
            <svg viewBox="0 0 24 24" width="17" height="17" fill="#fff">
              <path d="M12 2.6c.3 3.9 1.7 5.7 5.6 6.4-3.9.7-5.3 2.5-5.6 6.4-.3-3.9-1.7-5.7-5.6-6.4 3.9-.7 5.3-2.5 5.6-6.4z" />
              <path d="M18.4 14.4c.15 2 .85 2.9 2.85 3.25-2 .35-2.7 1.25-2.85 3.25-.15-2-.85-2.9-2.85-3.25 2-.35 2.7-1.25 2.85-3.25z" opacity="0.85" />
            </svg>
          </div>
          <div className="m-sheet-id">
            <b>{agentName}</b>
            <div className="m-sheet-state">
              <span className="m-live-dot" data-tone={tone(conversation)} />
              <StateLine conversation={conversation} />
            </div>
          </div>
          <button type="button" className="m-sheet-close" onClick={onClose} aria-label="关闭">
            ×
          </button>
        </div>

        <div className="m-thread" ref={threadRef}>
          {messages.length === 0 ? (
            <>
              <div className="m-msg" data-role="agent">
                <div className="m-bubble">
                  {blocked
                    ? "这个案例还没接上控制面，下面的示例问题仅作展示。"
                    : "你好，我是这家店的导购。说说你想要什么，或者从下面挑一个开始。"}
                </div>
              </div>
              <div className="m-openers">
                <div className="m-openers-label">示例问题（页面预置，不是 Agent 生成的建议）</div>
                {openers.map((text) => (
                  <button key={text} type="button" className="m-opener" onClick={() => submit(text)} disabled={blocked}>
                    <i>›</i>
                    {text}
                  </button>
                ))}
              </div>
            </>
          ) : null}

          {messages.map((message) =>
            message.role === "agent" ? (
              <AgentMessage key={message.id} message={message} actions={actions} disabled={busy} />
            ) : (
              <div className="m-msg" data-role={message.role} key={message.id}>
                <div className="m-bubble">{message.text}</div>
              </div>
            ),
          )}
        </div>

        <div className="m-composer">
          <textarea
            rows={1}
            value={draft}
            placeholder={blocked ? "未接入控制面" : busy ? "等这一轮回完再说…" : "说点什么…"}
            disabled={blocked || busy}
            onChange={(e) => {
              setDraft(e.target.value);
              e.target.style.height = "auto";
              e.target.style.height = `${Math.min(e.target.scrollHeight, 84)}px`;
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                submit(draft);
              }
            }}
          />
          <button
            type="button"
            className="m-send"
            disabled={blocked || busy || !draft.trim()}
            onClick={() => submit(draft)}
            aria-label="发送"
          >
            {busy ? <span className="m-spinner" /> : <IconSend />}
          </button>
        </div>
      </div>
    </>
  );
}
