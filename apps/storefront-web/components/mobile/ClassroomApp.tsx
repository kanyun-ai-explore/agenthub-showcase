"use client";

/**
 * 上课界面。
 *
 * 课件**由 agent 现编**：`present_slide` 传来标题、正文、教具，`present_exercise` 传来
 * 题目和选项，这里只负责画。原来是固定 8 页、agent 只能选页码，它想讲的和页面写的
 * 对不上，讲课就散了；现在讲什么和画什么出自同一个决定，所以是连贯的。
 *
 * 孩子点的答案会作为下一轮输入回给它，它据此决定继续讲还是退回去换个说法再讲。
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Conversation } from "@/components/agent/useAgentConversation";
import type { Visual } from "@/lib/course/types";
import { CoursewareVisual } from "./CoursewareVisual";
import { Octo, type OctoMood } from "./Octo";
import { IconSend } from "./icons";

interface SlidePayload {
  title: string;
  kind?: string;
  body?: string;
  visual?: Visual;
  note?: string;
}

interface ExercisePayload {
  prompt: string;
  options: string[];
  answer_index: number;
  hint?: string;
  explain?: string;
  visual?: Visual;
}

const KIND_LABEL: Record<string, string> = {
  intro: "热身",
  concept: "学新知",
  worked: "看例题",
  practice: "练一练",
  summary: "小结",
};

export function ClassroomApp({
  conversation,
  openers,
  lessonTitle,
  teacherName = "豆豆老师",
  welcomeText = "今天我们一起学数学。准备好了就点下面开始吧！",
}: {
  conversation: Conversation;
  openers: string[];
  lessonTitle: string;
  /** 欢迎屏的老师名与开场白：语文课等其它科目复用这个 app，从 surface 配置传入。 */
  teacherName?: string;
  welcomeText?: string;
}) {
  const [answered, setAnswered] = useState<Record<string, { index: number; correct: boolean }>>({});
  const [draft, setDraft] = useState("");
  const stageRef = useRef<HTMLDivElement>(null);

  // agent 发过来的每一页 / 每一题，按到达顺序排。
  const board = useMemo(() => {
    const items: { id: string; type: "slide" | "exercise"; payload: unknown }[] = [];
    for (const m of conversation.messages) {
      if (m.role !== "agent") continue;
      for (const c of m.cards) {
        if (c.component === "slide" || c.component === "exercise") {
          items.push({ id: c.id, type: c.component, payload: c.payload });
        }
      }
    }
    return items;
  }, [conversation.messages]);

  const current = board[board.length - 1];
  const slideCount = board.filter((b) => b.type === "slide").length;

  const streaming = conversation.messages.some((m) => m.role === "agent" && m.streaming);
  const lastText =
    [...conversation.messages].reverse().find((m) => m.role === "agent" && m.text)?.text ?? "";
  const lastAnswer = Object.values(answered).at(-1);

  const mood: OctoMood = streaming
    ? "talking"
    : conversation.busy
      ? "think"
      : lastAnswer?.correct
        ? "cheer"
        : "idle";

  useEffect(() => {
    stageRef.current?.scrollTo({ top: stageRef.current.scrollHeight, behavior: "smooth" });
  }, [board.length, lastText]);

  const answer = useCallback(
    (cardId: string, ex: ExercisePayload, chosen: number) => {
      const correct = chosen === ex.answer_index;
      setAnswered((prev) => ({ ...prev, [cardId]: { index: chosen, correct } }));
      conversation.send(
        correct
          ? `我选了「${ex.options[chosen]}」，答对了！`
          : `我选了「${ex.options[chosen]}」，好像不对。`,
      );
    },
    [conversation],
  );

  const send = (text: string) => {
    if (!text.trim() || conversation.busy) return;
    conversation.send(text);
    setDraft("");
  };

  const started = conversation.messages.length > 0;

  return (
    <div className="m-app cw-app">
      <div className="cw-sky">
        <span className="cw-cloud" style={{ left: "8%", top: 10 }} />
        <span className="cw-cloud" style={{ left: "62%", top: 24, transform: "scale(.75)" }} />
        <div className="cw-topline">
          <b>{lessonTitle}</b>
          <span>{slideCount > 0 ? `第 ${slideCount} 页` : "还没开始"}</span>
        </div>
      </div>

      <div className="cw-stage" ref={stageRef}>
        {!started ? (
          <div className="cw-welcome">
            <Octo mood="idle" size={110} />
            <h3>{teacherName}</h3>
            <p>{welcomeText}</p>
          </div>
        ) : null}

        {board.map((item, i) => {
          const isLast = i === board.length - 1;
          if (item.type === "slide") {
            const p = item.payload as SlidePayload;
            return (
              <div className="cw-slide" key={item.id} data-dim={!isLast}>
                <span className="cw-kind">{KIND_LABEL[p.kind ?? "concept"] ?? "学新知"}</span>
                <h3 className="cw-title">{p.title}</h3>
                {p.body ? <p className="cw-body">{p.body}</p> : null}
                {p.visual ? <CoursewareVisual visual={p.visual} /> : null}
                {p.note ? <div className="cw-note">{p.note}</div> : null}
              </div>
            );
          }

          const ex = item.payload as ExercisePayload;
          const done = answered[item.id];
          return (
            <div className="cw-slide cw-slide-ex" key={item.id} data-dim={!isLast}>
              <span className="cw-kind" data-tone="ex">
                练一练
              </span>
              {ex.visual ? <CoursewareVisual visual={ex.visual} /> : null}
              <div className="cw-ex-prompt">{ex.prompt}</div>
              <div className="cw-ex-options">
                {ex.options.map((option, oi) => {
                  const state = !done
                    ? "idle"
                    : oi === ex.answer_index
                      ? "right"
                      : done.index === oi
                        ? "wrong"
                        : "idle";
                  return (
                    <button
                      key={option}
                      type="button"
                      className="cw-opt"
                      data-state={state}
                      disabled={Boolean(done) || conversation.busy}
                      onClick={() => answer(item.id, ex, oi)}
                    >
                      {option}
                    </button>
                  );
                })}
              </div>
              {done ? (
                <div className="cw-ex-explain" data-correct={done.correct}>
                  {done.correct ? "答对啦！" : "再想想～"}
                  {done.correct && ex.explain ? ` ${ex.explain}` : ""}
                  {!done.correct && ex.hint ? ` ${ex.hint}` : ""}
                </div>
              ) : null}
            </div>
          );
        })}
      </div>

      <div className="cw-teacher">
        <Octo mood={mood} size={56} />
        <div className="cw-teacher-bubble">
          {started ? (
            <>
              {lastText || (streaming ? "" : "…")}
              {streaming ? <span className="m-caret" /> : null}
            </>
          ) : (
            "点下面的按钮，我们就开始上课啦～"
          )}
        </div>
      </div>

      {!started ? (
        <div className="cw-openers">
          {openers.map((text) => (
            <button key={text} type="button" className="cw-opener" onClick={() => send(text)}>
              {text}
            </button>
          ))}
        </div>
      ) : null}

      <div className="m-composer cw-composer">
        <textarea
          rows={1}
          value={draft}
          placeholder={conversation.busy ? "老师正在讲…" : "有不懂的就问我"}
          disabled={conversation.busy}
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
          className="m-send cw-send"
          disabled={conversation.busy || !draft.trim()}
          onClick={() => send(draft)}
          aria-label="发送"
        >
          {conversation.busy ? <span className="m-spinner" /> : <IconSend />}
        </button>
      </div>
    </div>
  );
}
