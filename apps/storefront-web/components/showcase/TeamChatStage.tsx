"use client";

/**
 * 「团队群」的舞台：中间手机放回放，手机下面是播放条，右边讲三件事——它替团队
 * 做什么、你要写什么、平台替你做什么。
 *
 * 和 `CaseStage` 分开，不复用它：`CaseStage` 一挂载就取访客身份、挂会话 hook，右栏的时间线和能力卡
 * 也都等真实会话的信号来点亮。这一页没有会话——不取身份、不建会话、不调 `/api/**`，只复用展示用的
 * 版式（时间线、代码块、能力卡），点亮它们的是回放的时钟：回放走到哪一幕，代码就亮哪几行。
 *
 * 右栏只写平台现在有的（出处见 `lib/team-chat/platform.ts`）。手机里画的是目标形态，哪些还没有，页面
 * 上只留一行小字。
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { TeamChatApp } from "@/components/mobile/TeamChatApp";
import { DOC_LINKS } from "@/lib/showcase/links";
import { AGENT_YAML, PLATFORM_DOES, SETUP_STEPS, SLACK_MANIFEST, marksOf, sourceOf, type ActId } from "@/lib/team-chat/platform";
import { actStateOf, advanceClock, clockOf, frameAt, reachedAct } from "@/lib/team-chat/replay";
import { TEAM_CHAT_SCRIPT } from "@/lib/team-chat/script";
import { Footer } from "./Chrome";
import { Code } from "./Code";
import { PhoneFrame } from "./PhoneFrame";

const SCRIPT = TEAM_CHAT_SCRIPT;
/** 时钟多久推一次画面（约 30 帧每秒）。 */
const FRAME_MS = 33;
/** 两帧之间最多算这么久：标签页切走再回来，回放接着播，不跳过一大段。 */
const MAX_STEP_MS = 100;

function IconPlay() {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <path d="M8 5.5v13l11-6.5-11-6.5Z" />
    </svg>
  );
}

function IconPause() {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <path d="M7 5h3.5v14H7zM13.5 5H17v14h-3.5z" />
    </svg>
  );
}

function Check() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3.5" strokeLinecap="round" strokeLinejoin="round">
      <path d="M20 6 9 17l-5-5" />
    </svg>
  );
}

function IconReplay() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M4 12a8 8 0 1 0 2.6-5.9" />
      <path d="M4 4v4.5h4.5" />
    </svg>
  );
}

export function TeamChatStage() {
  // 减少动态效果：null = 还没读到（服务端渲染和首帧），读到之后才决定要不要自动播放。
  const [reduced, setReduced] = useState<boolean | null>(null);
  const [t, setT] = useState(0);
  const [playing, setPlaying] = useState(false);
  const clock = useRef(0);

  const seek = useCallback((ms: number) => {
    clock.current = ms;
    setT(ms);
  }, []);

  useEffect(() => {
    const query = window.matchMedia("(prefers-reduced-motion: reduce)");
    const apply = () => setReduced(query.matches);
    apply();
    query.addEventListener("change", apply);
    return () => query.removeEventListener("change", apply);
  }, []);

  // 正常情况进页面就自动播；开了「减少动态效果」的不自动播，直接摆出播完的整段，要看过程再点重播。
  useEffect(() => {
    if (reduced === null) return;
    if (reduced) {
      seek(SCRIPT.end);
      setPlaying(false);
    } else {
      seek(0);
      setPlaying(true);
    }
  }, [reduced, seek]);

  useEffect(() => {
    if (!playing) return;
    let raf = 0;
    let last = performance.now();
    let shown = last;
    const tick = (now: number) => {
      clock.current = advanceClock(clock.current, now - last, SCRIPT.end, MAX_STEP_MS);
      last = now;
      if (now - shown >= FRAME_MS || clock.current >= SCRIPT.end) {
        shown = now;
        setT(clock.current);
      }
      if (clock.current >= SCRIPT.end) {
        setPlaying(false);
        return;
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [playing]);

  const frame = useMemo(() => frameAt(SCRIPT, t), [t]);

  const replay = () => {
    seek(0);
    setPlaying(true);
  };
  const toggle = () => {
    if (frame.ended) replay();
    else setPlaying((v) => !v);
  };
  const jump = (at: number) => {
    seek(at);
    setPlaying(true);
  };

  const act = SCRIPT.acts[frame.act];
  const actId = act.id as ActId;
  const stateOf = (index: number) => actStateOf(frame, index);
  /** 这一幕在回放里演到了没有（能力卡据此点亮）。 */
  const reached = (id: ActId) => reachedAct(frame, SCRIPT.acts.findIndex((a) => a.id === id));

  return (
    <>
      <section className="stage">
        <PhoneFrame>
          <TeamChatApp script={SCRIPT} frame={frame} playing={playing} reduced={reduced === true} />
        </PhoneFrame>
        <div className="replay-bar" aria-label="回放控制">
          <button type="button" className="replay-btn" onClick={toggle} aria-label={playing ? "暂停" : frame.ended ? "重播" : "播放"}>
            {playing ? <IconPause /> : <IconPlay />}
          </button>
          <button type="button" className="replay-btn" onClick={replay} aria-label="重播">
            <IconReplay />
          </button>
          <ol className="replay-acts">
            {SCRIPT.acts.map((a, i) => (
              <li key={a.id} data-state={stateOf(i)}>
                <button type="button" onClick={() => jump(a.at)} aria-label={`跳到第 ${i + 1} 幕：${a.title}`} aria-current={stateOf(i) === "active"}>
                  {i + 1}
                </button>
              </li>
            ))}
          </ol>
          <span className="replay-now">{frame.ended ? "播完了" : act.short}</span>
          <span className="replay-time">
            {clockOf(t)} / {clockOf(SCRIPT.end)}
          </span>
        </div>
      </section>

      <main className="reading">
        <article className="reading-inner">
          <header className="lead">
            <div className="lead-eyebrow">
              <span className="pill">团队群</span>
              <code>channels: type: slack</code>
            </div>
            <h1>Agent 在团队群里旁听、动手，大事先请人确认</h1>
            <p>
              群里有人说告警反复响、阈值该改，或者线上出了故障，Agent 不用人 @
              就能接住。可以撤销的小事它直接办完再报告；改线上的事它先发确认，有人批准才做；做到一半可以随时叫停。你要写的是一份
              agent.yaml：声明 Slack 渠道、它能调的工具、哪些工具要先问人。
            </p>
            <p className="lead-note">手机里是按脚本播放的原型，不能操作，人名和读数是编的；消息里的卡片和按钮、它自己先发现故障，是目标形态。</p>
            <dl className="stats">
              <div>
                <dt>渠道</dt>
                <dd>Slack</dd>
              </div>
              <div>
                <dt>什么时候开口</dt>
                <dd>@ · 线程跟进 · 旁听</dd>
              </div>
              <div>
                <dt>写动作</dt>
                <dd>按工具声明审批</dd>
              </div>
              <div>
                <dt>打断</dt>
                <dd>线程里的 Stop</dd>
              </div>
            </dl>
          </header>

          <section className="sec">
            <div className="sec-head">
              <h2>它替团队做的四件事</h2>
              <span>跟着回放亮起，点一行跳到那一幕</span>
            </div>
            <ol className="tl replay-tl">
              {SCRIPT.acts.map((a, i) => (
                <li className="tl-row" key={a.id} data-state={stateOf(i)}>
                  <span className="tl-dot">{i + 1}</span>
                  <div className="tl-main">
                    <div className="tl-label">{a.title}</div>
                    <div className="tl-sub">{a.look}</div>
                  </div>
                  <button type="button" className="tl-time replay-jump" onClick={() => jump(a.at)} aria-label={`跳到第 ${i + 1} 幕`}>
                    {clockOf(a.at)}
                  </button>
                </li>
              ))}
            </ol>
          </section>

          <section className="sec">
            <div className="sec-head">
              <h2>你要写的</h2>
              <span>
                亮着的是第 {frame.act + 1} 幕用到的几行
              </span>
            </div>
            <Code title={AGENT_YAML.title} mark={marksOf(AGENT_YAML, actId)}>
              {sourceOf(AGENT_YAML)}
            </Code>
            <Code title={SLACK_MANIFEST.title} mark={marksOf(SLACK_MANIFEST, actId)}>
              {sourceOf(SLACK_MANIFEST)}
            </Code>
            <ol className="steps">
              {SETUP_STEPS.map((step, index) => (
                <li className="step" key={step.title}>
                  <span className="step-n">{index + 1}</span>
                  <div className="step-body">
                    <h4>{step.title}</h4>
                    <p>{step.body}</p>
                  </div>
                </li>
              ))}
            </ol>
          </section>

          <section className="sec">
            <div className="sec-head">
              <h2>平台替你做的</h2>
              <span>回放演到哪一幕，亮到哪一张</span>
            </div>
            <div className="caps">
              {PLATFORM_DOES.map((item, i) => {
                const live = reached(item.act);
                return (
                  <div className="cap" key={item.act} data-live={live}>
                    <div className="cap-head">
                      <span className="cap-state">
                        <Check />
                      </span>
                      <b>{item.name}</b>
                      {live ? <span className="cap-flag">第 {i + 1} 幕</span> : null}
                    </div>
                    <p>{item.blurb}</p>
                    <code>{item.evidence}</code>
                  </div>
                );
              })}
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
