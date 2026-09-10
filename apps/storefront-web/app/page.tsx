/**
 * 首页：场景总览。
 *
 * 场景变成两个以上之后，直接落在其中一个上就是在替读者做选择。这里先让人看见有哪些
 * 场景、每个场景里有哪几个视角，再点进去。
 */

import type { Metadata } from "next";
import { Footer, ScenarioIcon, TopBar } from "@/components/showcase/Chrome";
import { CAPABILITIES } from "@/lib/showcase/capabilities";
import { DOC_LINKS } from "@/lib/showcase/links";
import { PLATFORM_EXTENSIONS, SCENARIOS } from "@/lib/showcase/cases";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "AgentHub Showcase",
  description: "在 AgentHub 上真实跑起来的 agent：电商导购与商家助手、在线教育的 AI 教研团队。",
};

export default function Home() {
  const agents = SCENARIOS.reduce((n, s) => n + s.surfaces.length, 0);
  const figures = [
    { n: SCENARIOS.length, label: "业务场景" },
    { n: agents, label: "个 Agent 在线" },
    { n: Object.keys(CAPABILITIES).length, label: "项平台能力" },
  ];

  return (
    <div className="site">
      <TopBar />

      <main className="home">
        <section className="hero">
          <div className="hero-copy">
            <span className="eyebrow">AgentHub Showcase</span>
            <h1>
              把 Agent 当成
              <br />
              产品的一部分来交付
            </h1>
            <p>
              下面每个场景都是真的在跑：Agent 的定义是仓库里的文件，走流水线发布；它在隔离沙箱里调用真实的业务工具，
              用生成式 UI 把结果渲染成能看能点的界面。手机可以真的点，旁边写明这一幕用到了平台的哪些能力、每条在仓库里的出处。
            </p>
            <div className="hero-actions">
              <a className="btn btn-primary btn-lg" href={`/showcase/${SCENARIOS[0].id}`}>
                进入演示
              </a>
              <a className="btn btn-lg" href={DOC_LINKS[0].href} target="_blank" rel="noreferrer">
                阅读文档
              </a>
            </div>
          </div>
          <dl className="hero-figures">
            {figures.map((f) => (
              <div key={f.label}>
                <dd>{f.n}</dd>
                <dt>{f.label}</dt>
              </div>
            ))}
          </dl>
        </section>

        <section className="sec">
          <div className="sec-head">
            <h2>场景</h2>
            <span>每个场景是一组分工不同的 Agent，点进去就能上手</span>
          </div>
          <div className="scen-grid">
            {SCENARIOS.map((scenario) => (
              <a className="scen" key={scenario.id} href={`/showcase/${scenario.id}`}>
                <div className="scen-icon">
                  <ScenarioIcon id={scenario.id} />
                </div>
                <div className="scen-body">
                  <h3>{scenario.name}</h3>
                  <p>{scenario.blurb}</p>
                  <ol className="scen-surfaces">
                    {scenario.surfaces.map((s) => (
                      <li key={s.id}>
                        <b>{s.name}</b>
                        <span>{s.persona}</span>
                      </li>
                    ))}
                  </ol>
                </div>
                <span className="scen-go">进入 →</span>
              </a>
            ))}
          </div>
        </section>

        <section className="sec">
          <div className="sec-head">
            <h2>平台在这类场景里给你的</h2>
          </div>
          <div className="ext-grid" data-cols="4">
            {PLATFORM_EXTENSIONS.map((ext) => (
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
            <span>文档、SDK，以及这个页面自己的源码</span>
          </div>
          <div className="links" data-cols="2">
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
      </main>

      <Footer />
    </div>
  );
}
