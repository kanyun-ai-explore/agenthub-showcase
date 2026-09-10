"use client";

/**
 * 微信风格的对话界面，销售顾问 / 批改助手 / 学情分析共用。
 *
 * 之所以做成微信的样子：这三个角色在真实业务里就活在微信里，家长和老师不会为了跟
 * 一个 agent 说话再装一个 App。演示要让业务方一眼认出「这就是我们现在的沟通渠道」。
 *
 * 生成式卡片直接插在气泡流里——这是它跟普通客服机器人的区别：不是回一段文字让你自己
 * 读，是把课程方案、批改结果、学情周报渲染成能看能点的东西。
 */

import { useEffect, useRef, useState } from "react";
import { GenerativeCard } from "@/components/generative";
import type { Conversation, Message } from "@/components/agent/useAgentConversation";
import { IconSend } from "./icons";

function StatusBar() {
  return (
    <div className="m-status" data-dark="true">
      <span>9:41</span>
      <span className="m-status-right">
        <span style={{ fontSize: 10.5, fontWeight: 700 }}>5G</span>
        <span className="m-battery" />
      </span>
    </div>
  );
}

function stateLine(conversation: Conversation): string {
  const { phase, busy, elapsed } = conversation;
  if (phase === "unconfigured") return "未接入";
  if (phase === "error") return conversation.error ?? "出错了";
  if (phase === "creating") return "连接中…";
  if (phase === "starting") return `启动中 ${elapsed}s`;
  if (phase === "reviving") return `恢复中 ${elapsed}s`;
  if (busy) return "对方正在输入…";
  return "在线";
}

function AgentTurn({
  message,
  onPick,
  busy,
}: {
  message: Extract<Message, { role: "agent" }>;
  onPick: (text: string) => void;
  busy: boolean;
}) {
  const tools = message.trace.filter((t) => t.kind !== "present");
  return (
    <>
      {tools.length > 0 ? (
        <div className="wc-trace">
          {tools.map((t) => (
            <span key={t.id}>
              {t.done ? "✓" : "…"} {t.label}
            </span>
          ))}
        </div>
      ) : null}

      {message.cards.map((card) => (
        <div className="wc-card-wrap" key={card.id}>
          <GenerativeCard
            component={card.component}
            payload={card.payload}
            actions={{ onPickSuggestion: onPick }}
            disabled={busy}
          />
        </div>
      ))}

      {message.text || (!message.streaming && message.cards.length === 0) ? (
        <div className="wc-row" data-role="agent">
          <div className="wc-avatar" data-role="agent">
            豆
          </div>
          <div className="wc-bubble" data-role="agent">
            {message.text || "（这一轮没有返回内容）"}
            {message.streaming && message.text ? <span className="m-caret" /> : null}
          </div>
        </div>
      ) : null}

      {message.streaming && !message.text && message.cards.length === 0 ? (
        <div className="wc-row" data-role="agent">
          <div className="wc-avatar" data-role="agent">
            豆
          </div>
          <div className="wc-bubble" data-role="agent">
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

export function WeChatApp({
  conversation,
  openers,
  contactName,
  contactTag,
}: {
  conversation: Conversation;
  openers: string[];
  contactName: string;
  /** 会话名下面那行小字，例如「课程顾问」。 */
  contactTag: string;
}) {
  const [draft, setDraft] = useState("");
  const threadRef = useRef<HTMLDivElement>(null);
  const { messages, busy, phase } = conversation;
  const blocked = phase === "unconfigured" || phase === "error";

  useEffect(() => {
    const el = threadRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages]);

  useEffect(() => {
    conversation.start();
    // 只在挂载时起会话：微信是一进来就连上的，不需要再点一次
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const send = (text: string) => {
    if (!text.trim() || busy || blocked) return;
    conversation.send(text);
    setDraft("");
  };

  return (
    <div className="m-app wc-app">
      <StatusBar />

      <div className="wc-head">
        <span className="wc-back">‹</span>
        <div className="wc-head-id">
          <b>{contactName}</b>
          <span>
            {contactTag} · {stateLine(conversation)}
          </span>
        </div>
        <span className="wc-more">···</span>
      </div>

      <div className="wc-thread" ref={threadRef}>
        <div className="wc-day">今天</div>

        {messages.length === 0 ? (
          <>
            <div className="wc-row" data-role="agent">
              <div className="wc-avatar" data-role="agent">
                豆
              </div>
              <div className="wc-bubble" data-role="agent">
                {blocked ? "这个视角还没接入控制面，下面的示例问题仅作展示。" : `你好，我是${contactTag}${contactName}。有什么想问的？`}
              </div>
            </div>
            <div className="wc-openers">
              <div className="wc-openers-label">示例问题（页面预置，不是 Agent 生成的建议）</div>
              {openers.map((text) => (
                <button key={text} type="button" className="wc-opener" onClick={() => send(text)} disabled={blocked}>
                  {text}
                </button>
              ))}
            </div>
          </>
        ) : null}

        {messages.map((message) =>
          message.role === "agent" ? (
            <AgentTurn key={message.id} message={message} onPick={send} busy={busy} />
          ) : message.role === "user" ? (
            <div className="wc-row" data-role="user" key={message.id}>
              <div className="wc-bubble" data-role="user">
                {message.text}
              </div>
              <div className="wc-avatar" data-role="user">
                我
              </div>
            </div>
          ) : (
            <div className="wc-sys" key={message.id}>
              {message.text}
            </div>
          ),
        )}
      </div>

      <div className="wc-composer">
        <textarea
          rows={1}
          value={draft}
          placeholder={blocked ? "未接入" : busy ? "等这一轮回完再说…" : ""}
          disabled={blocked || busy}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              send(draft);
            }
          }}
        />
        <button
          type="button"
          className="wc-send"
          disabled={blocked || busy || !draft.trim()}
          onClick={() => send(draft)}
          aria-label="发送"
        >
          {busy ? <span className="m-spinner" /> : <IconSend />}
        </button>
      </div>
    </div>
  );
}
