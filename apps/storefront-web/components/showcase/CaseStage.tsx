"use client";

/**
 * 一个视角的舞台：中间手机，右边解说。
 *
 * 右栏不是静态宣传文案——时间线和能力清单由对话真实发出的信号点亮，页面上没有
 * 任何靠定时器或页面加载就自己亮起来的东西。
 */

import { useEffect, useMemo, useRef, useState } from "react";
import type { Product } from "@/lib/backend/types";
import {
  useAgentConversation,
  type Conversation,
  type PrewarmSignal,
} from "@/components/agent/useAgentConversation";
import { CAPABILITIES, type CapabilityId, type CapabilitySignal } from "@/lib/showcase/capabilities";
import { PLATFORM_EXTENSIONS, type Scenario, type Surface } from "@/lib/showcase/cases";
import { readPrewarmHandle, writePrewarmHandle } from "@/lib/agenthub/prewarm-handle";
import { DOC_LINKS, GETTING_STARTED, repoFileHref } from "@/lib/showcase/links";
import { readVisitorId, rememberVisitorId, resetVisitorId } from "@/lib/showcase/visitor";
import { ShoppingApp } from "@/components/mobile/ShoppingApp";
import { MerchantApp } from "@/components/mobile/MerchantApp";
import { WeChatApp } from "@/components/mobile/WeChatApp";
import { ClassroomApp } from "@/components/mobile/ClassroomApp";
import { EnglishCourseApp } from "@/components/mobile/EnglishCourseApp";
import { RoleplayApp } from "@/components/mobile/RoleplayApp";
import type { Lesson } from "@/lib/course/types";
import { Footer } from "./Chrome";
import { Code } from "./Code";
import { PhoneFrame } from "./PhoneFrame";

export interface CatalogSeed {
  products: Product[];
  categories: string[];
  counts: Record<string, number>;
  total: number;
}

interface LiveEvent {
  signal: CapabilitySignal | PrewarmSignal;
  detail?: string;
  at: number;
}

// 按一轮真实发生的顺序排：流式在第一个 present_* 之前就开始了。
// 带 `caps` 的步骤只在声明了对应能力的视角上出现——语音回合这条挂到别的视角上，
// 会永远停在「未发生」，那块时间线就成了替它吹的牛。同理，`format: live` 的视角
// （没有沙箱、没有工具、没有生成式 UI）也不该摆着那三步等它永远不亮。
const STEPS: {
  signal: CapabilitySignal | PrewarmSignal;
  label: string;
  hint: string;
  caps?: CapabilityId[];
}[] = [
  { signal: "session-created", label: "创建会话", hint: "sessions.create，带上这次的身份配置" },
  {
    signal: "sandbox-ready",
    label: "沙箱就绪",
    hint: "拉起隔离容器，装载 Agent 的文件定义",
    caps: ["sandbox"],
  },
  { signal: "prewarm-hit", label: "预热命中", hint: "复用为同一学生预建的会话，跳过冷启动" },
  { signal: "prewarm-miss", label: "预热未命中", hint: "预建会话已失效，改走正常冷启动" },
  { signal: "prewarm-started", label: "预热其他课", hint: "为同一访客预建其他 Agent 的会话" },
  { signal: "stream-chunk", label: "流式输出", hint: "SSE 逐字回传，断线后带游标续上" },
  { signal: "tool-call", label: "调用工具", hint: "经托管 MCP 调用真实的业务能力", caps: ["mcp"] },
  {
    signal: "present-card",
    label: "生成式 UI",
    hint: "返回结构化组件数据，前端渲染成卡片",
    caps: ["generative-ui"],
  },
  {
    signal: "voice-turn",
    label: "语音回合",
    hint: "录音 → 平台转写 → Agent 拿到文本，和打字输入的一样",
    caps: ["voice-turn"],
  },
];

/** 微信会话页顶上显示的联系人。 */
const CONTACT: Record<string, { name: string; tag: string }> = {
  "course-sales": { name: "小豆", tag: "课程顾问" },
  "homework-qa": { name: "批改助手", tag: "作业答疑" },
  "learning-analytics": { name: "学情分析", tag: "教研助手" },
};

function Check() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3.5" strokeLinecap="round" strokeLinejoin="round">
      <path d="M20 6 9 17l-5-5" />
    </svg>
  );
}

/** `sandbox`：这个视角的 agent 有没有沙箱（live 视角没有，不能说「沙箱启动中」）。 */
function statusOf(c: Conversation, sandbox: boolean): { tone: "idle" | "busy" | "ok" | "bad"; text: string } {
  switch (c.phase) {
    case "creating":
    case "starting":
      return { tone: "busy", text: sandbox ? `沙箱启动中 · ${c.elapsed}s` : `会话建立中 · ${c.elapsed}s` };
    case "reviving":
      return { tone: "busy", text: "会话被回收过，正在恢复" };
    case "ready":
      return { tone: "ok", text: `会话 ${c.sessionId?.slice(0, 8)} · ${c.busy ? "Agent 思考中" : "就绪"}` };
    case "error":
      return { tone: "bad", text: c.error ?? "出错了" };
    case "unconfigured":
      return { tone: "bad", text: "这个视角的 Agent 还没配置" };
    default:
      return { tone: "idle", text: "这台手机可以真的点，Agent 在里面" };
  }
}

export function CaseStage({
  scenario,
  surface,
  catalog,
  lesson,
}: {
  scenario: Scenario;
  surface: Surface;
  catalog?: CatalogSeed;
  lesson?: Lesson;
}) {
  const [events, setEvents] = useState<LiveEvent[]>([]);
  const [tools, setTools] = useState<string[]>([]);
  const [settleToken, setSettleToken] = useState(0);
  // 访客身份分两层：浏览器本地的 id 只是冷启回退；会话真正用的身份是平台给的
  // （命中预热池时是暖机时铸好的 EUID），从 conversation.userId 读回。手机里那些后端
  // 请求的 X-CMA-User 必须跟会话用的是同一个值，「换个身份」才不会只换一半——所以
  // 换身份 = 换会话（整页重载）。
  const [localVisitorId, setLocalVisitorId] = useState<string | null>(null);
  useEffect(() => setLocalVisitorId(readVisitorId()), []);

  const conversation = useAgentConversation({
    agent: surface.agent ?? "shopping",
    endUserId: localVisitorId,
    onSignal: (signal, detail) => {
      if (signal === "tool-call" && detail) {
        setTools((prev) => (prev.includes(detail) ? prev : [...prev, detail]));
      }
      setEvents((prev) =>
        prev.some((e) => e.signal === signal)
          ? prev.map((e) => (e.signal === signal ? { ...e, detail: detail ?? e.detail } : e))
          : [...prev, { signal, detail, at: Date.now() }],
      );
    },
    onSettled: () => setSettleToken((v) => v + 1),
    // 英语课冷启时孩子在等第一关，就绪轮询间隔直接叠在等待上；其它视角不变。
    readyPollMs: surface.app === "english" ? 300 : undefined,
  });

  const visitorId = conversation.userId ?? localVisitorId;
  // 会话拿到平台身份后记成本地 id：服务端已把会话前的购物车/记忆搬到它名下，下次来访
  // 再从它搬到下一个会话——身份一段段接着走，而不是每次来访从零开始。
  useEffect(() => {
    if (conversation.userId) rememberVisitorId(conversation.userId);
  }, [conversation.userId]);
  // 跨 agent 预热：本会话就绪后，为同一访客预建 surface.prewarm 里那些 agent 的会话，
  // 学生切课到那边直接复用、不再冷启。句柄存浏览器（站点多副本，服务端 .data 是 pod
  // 本地）；ref 保证每个 (visitorId, sibling) 只发一次预建请求。
  const prewarmedRef = useRef<Set<string>>(new Set());
  useEffect(() => {
    if (conversation.phase !== "ready" || !visitorId || !surface.prewarm?.length) return;
    for (const sibling of surface.prewarm) {
      const dedupeKey = `${visitorId}:${sibling}`;
      if (prewarmedRef.current.has(dedupeKey)) continue;
      prewarmedRef.current.add(dedupeKey);
      if (readPrewarmHandle(sibling, visitorId)) continue;
      void (async () => {
        try {
          const res = await fetch("/api/agenthub/session/prewarm", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ agent: sibling, endUserId: visitorId }),
          });
          const data = (await res.json()) as { agentHubSessionId?: string; status?: string; detail?: string };
          if (!res.ok || !data.agentHubSessionId) {
            throw new Error(data.detail ?? `预热失败（HTTP ${res.status}）`);
          }
          writePrewarmHandle({
            sessionId: data.agentHubSessionId,
            userId: visitorId,
            agent: sibling,
            createdAt: Date.now(),
          });
          setEvents((prev) => [
            ...prev,
            { signal: "prewarm-started", detail: `${sibling} → ${data.agentHubSessionId}`, at: Date.now() },
          ]);
        } catch (err) {
          console.warn(`[case-stage] prewarm ${sibling} for ${visitorId} failed`, err);
          setEvents((prev) => [
            ...prev,
            {
              signal: "prewarm-started",
              detail: `${sibling} 预热失败：${err instanceof Error ? err.message : String(err)}`,
              at: Date.now(),
            },
          ]);
        }
      })();
    }
  }, [conversation.phase, visitorId, surface.prewarm]);
  const seen = useMemo(() => new Map(events.map((e) => [e.signal, e])), [events]);
  // 时间线按视角裁剪：语音回合那条只出现在声明了它的视角上（见 STEPS 上的注释）。
  const steps = useMemo(
    () => STEPS.filter((step) => !step.caps || step.caps.some((cap) => surface.capabilities.includes(cap))),
    [surface.capabilities],
  );
  const first = events.length > 0 ? events[0].at : 0;
  const toolNames = useMemo(() => (tools.length > 0 ? tools.join(" · ") : null), [tools]);
  const status = statusOf(conversation, surface.capabilities.includes("sandbox"));
  const agentId = surface.meta.find((m) => m.label === "Agent")?.value;

  return (
    <>
      <section className="stage">
        <PhoneFrame>
          {surface.app === "merchant" ? (
            <MerchantApp conversation={conversation} openers={surface.openers} settleToken={settleToken} />
          ) : surface.app === "wechat" ? (
            <WeChatApp
              conversation={conversation}
              openers={surface.openers}
              contactName={CONTACT[surface.id]?.name ?? surface.name}
              contactTag={CONTACT[surface.id]?.tag ?? surface.persona}
            />
          ) : surface.app === "classroom" ? (
            <ClassroomApp conversation={conversation} openers={surface.openers} lessonTitle={surface.lessonTitle ?? lesson?.title ?? "数学课"} teacherName={surface.teacherName} welcomeText={surface.welcomeText} />
          ) : surface.app === "english" ? (
            <EnglishCourseApp conversation={conversation} openers={surface.openers} visitorId={visitorId} lessonTitle={surface.lessonTitle} teacherName={surface.teacherName} welcomeText={surface.welcomeText} />
          ) : surface.app === "roleplay" ? (
            <RoleplayApp conversation={conversation} openers={surface.openers} visitorId={visitorId} sceneTitle={surface.lessonTitle} clerkName={surface.teacherName} welcomeText={surface.welcomeText} />
          ) : (
            <ShoppingApp
              conversation={conversation}
              openers={surface.openers}
              settleToken={settleToken}
              visitorId={visitorId}
              onForget={() => {
                resetVisitorId();
                window.location.reload();
              }}
              initialProducts={catalog?.products ?? []}
              categories={catalog?.categories ?? []}
              counts={catalog?.counts ?? {}}
              total={catalog?.total ?? 0}
            />
          )}
        </PhoneFrame>
        <div className="stage-status" data-tone={status.tone}>
          <span className="stage-dot" />
          {status.text}
        </div>
      </section>

      <main className="reading">
        <article className="reading-inner">
          <header className="lead">
            <div className="lead-eyebrow">
              <span className="pill">{surface.persona}视角</span>
              {agentId ? <code>{agentId}</code> : null}
            </div>
            <h1>{surface.tagline}</h1>
            <p>{surface.intro}</p>
            <dl className="stats">
              {surface.meta.map((item) => (
                <div key={item.label}>
                  <dt>{item.label}</dt>
                  <dd>{item.value}</dd>
                </div>
              ))}
            </dl>
          </header>

          <section className="sec">
            <div className="sec-head">
              <h2>会话时间线</h2>
              <span>{events.length === 0 ? "打开手机里的 Agent 后逐步点亮" : "本次会话真实发生的事件"}</span>
            </div>
            <ol className="tl">
              {steps.map((step, index) => {
                const event = seen.get(step.signal);
                const laterSeen = steps.slice(index + 1).some((s) => seen.has(s.signal));
                const state = event ? (laterSeen ? "done" : "active") : "idle";
                const detail =
                  event && step.signal === "session-created" && conversation.sessionId
                    ? conversation.sessionId
                    : event && step.signal === "tool-call" && toolNames
                      ? toolNames
                      : event?.detail ?? step.hint;
                return (
                  <li className="tl-row" key={step.signal} data-state={state}>
                    <span className="tl-dot">{event ? <Check /> : index + 1}</span>
                    <div className="tl-main">
                      <div className="tl-label">{step.label}</div>
                      <div className="tl-sub">{detail}</div>
                    </div>
                    <span className="tl-time">
                      {event ? `+${Math.max(0, Math.round((event.at - first) / 1000))}s` : ""}
                    </span>
                  </li>
                );
              })}
            </ol>
            {conversation.sessionId && conversation.portalHref ? (
              <a
                className="tl-open"
                href={conversation.portalHref}
                target="_blank"
                rel="noreferrer"
              >
                <span className="tl-open-title">在 AgentHub 控制台打开这个会话 ↗</span>
                <span className="tl-open-sub">
                  平台记录了每轮的输入输出与工具调用、思考片段、token 用量与成本估算、trace、产物文件和上下文占用
                </span>
              </a>
            ) : null}
          </section>

          <section className="sec">
            <div className="sec-head">
              <h2>用到的平台能力</h2>
              <span>亮起的是本次会话里实际发生过的</span>
            </div>
            <div className="caps">
              {surface.capabilities.map((id) => {
                const capability = { ...CAPABILITIES[id], ...surface.capabilityOverrides?.[id] };
                const live =
                  capability.signal !== null &&
                  seen.has(capability.signal) &&
                  (capability.tools === undefined || capability.tools.some((t) => tools.includes(t)));
                return (
                  <div className="cap" key={id} data-live={live}>
                    <div className="cap-head">
                      <span className="cap-state">
                        <Check />
                      </span>
                      <b>{capability.name}</b>
                      {live ? <span className="cap-flag">已发生</span> : null}
                    </div>
                    <p>{capability.blurb}</p>
                    <code>
                      <Evidence text={capability.evidence} />
                    </code>
                  </div>
                );
              })}
            </div>
          </section>

          <section className="sec">
            <div className="sec-head">
              <h2>实现方式</h2>
              <span>三步，这个页面就是这样接入的</span>
            </div>
            <Code title={surface.agentFile} href={repoFileHref(surface.agentFile)}>
              {surface.snippet}
            </Code>
            <ol className="steps">
              {GETTING_STARTED.map((step, index) => (
                <li className="step" key={step.title}>
                  <span className="step-n">{index + 1}</span>
                  <div className="step-body">
                    <h4>{step.title}</h4>
                    <p>{step.body}</p>
                    {step.code ? <Code>{step.code}</Code> : null}
                  </div>
                </li>
              ))}
            </ol>
          </section>

          <section className="sec">
            <div className="sec-head">
              <h2>同一套能力的其他用法</h2>
              <span>换工具、换提示词，不换平台</span>
            </div>
            <div className="ext-grid">
              {[...scenario.extensions, ...PLATFORM_EXTENSIONS].map((ext) => (
                <div className="ext" key={ext.title}>
                  <h3>{ext.title}</h3>
                  <p>{ext.body}</p>
                </div>
              ))}
            </div>
          </section>

          <section className="sec">
            <div className="sec-head">
              <h2>从这里开始</h2>
              <span>文档、SDK 和本页面的源码</span>
            </div>
            <div className="links">
              {DOC_LINKS.map((link) => (
                <a className="link" key={link.href} href={link.href} target="_blank" rel="noreferrer">
                  <div className="link-main">
                    <b>{link.title}</b>
                    <span>{link.sub}</span>
                  </div>
                  <span className="link-arrow">↗</span>
                </a>
              ))}
            </div>
          </section>

          <Footer compact />
        </article>
      </main>
    </>
  );
}

/**
 * 能力卡片底下那行「出处」。只有以 `agenthub/` 开头的才是仓库路径，渲染成跳到公开仓库
 * 对应文件的链接；`a/b/agent.yaml + CLAUDE.md` 这种写法，后面的文件名落在前一个的目录里。
 * 其它出处（工具名、env 变量、模型名）是文案，原样输出。
 */
function Evidence({ text }: { text: string }) {
  if (!text.startsWith("agenthub/")) return <>{text}</>;
  const parts = text.split(" + ");
  const dir = parts[0].slice(0, parts[0].lastIndexOf("/") + 1);
  return (
    <>
      {parts.map((part, i) => (
        <span key={part}>
          {i > 0 ? " + " : null}
          <a href={repoFileHref(part.includes("/") ? part : `${dir}${part}`)} target="_blank" rel="noreferrer">
            {part}
          </a>
        </span>
      ))}
    </>
  );
}

