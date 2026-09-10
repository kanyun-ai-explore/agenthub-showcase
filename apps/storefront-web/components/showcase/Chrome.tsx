/** 站点框架：顶栏（含场景切换）、视角侧栏、页脚。全部读场景注册表。 */

import { SCENARIOS, type Scenario } from "@/lib/showcase/cases";
import { AGENTHUB_DOCS, AGENTHUB_PORTAL, REPO } from "@/lib/showcase/links";

export function ScenarioIcon({ id }: { id: string }) {
  if (id === "commerce") {
    return (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
        <path d="M6 7h12l1 13H5L6 7Z" />
        <path d="M9 10V6a3 3 0 0 1 6 0v4" />
      </svg>
    );
  }
  if (id === "education") {
    return (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
        <path d="m3 9 9-4 9 4-9 4-9-4Z" />
        <path d="M7 11v4c0 1.5 2.5 3 5 3s5-1.5 5-3v-4" />
        <path d="M21 9v5" />
      </svg>
    );
  }
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round">
      <circle cx="12" cy="12" r="8" />
    </svg>
  );
}

export function TopBar({ scenarioId }: { scenarioId?: string }) {
  return (
    <header className="topbar">
      <a href="/" className="brand">
        {/* 品牌图形是固定素材：不重绘、不改色。 */}
        <img src="/brand/agenthub-mark-192.png" alt="" draggable={false} />
        <span>AgentHub</span>
        <span className="brand-sub">Showcase</span>
      </a>

      <nav className="scen-tabs" aria-label="场景">
        {SCENARIOS.map((s) => (
          <a key={s.id} href={`/showcase/${s.id}`} className="scen-tab" data-active={s.id === scenarioId}>
            <ScenarioIcon id={s.id} />
            {s.name}
          </a>
        ))}
      </nav>

      <nav className="top-links">
        <a href={AGENTHUB_PORTAL} target="_blank" rel="noreferrer">
          控制台
        </a>
        <a href={REPO} target="_blank" rel="noreferrer">
          源码
        </a>
        <a className="btn btn-primary" href={AGENTHUB_DOCS} target="_blank" rel="noreferrer">
          阅读文档
        </a>
      </nav>
    </header>
  );
}

/** 左栏：当前场景下的视角。 */
export function SideNav({ scenario, surfaceId }: { scenario: Scenario; surfaceId: string }) {
  return (
    <aside className="side">
      <div className="side-head">
        <div className="side-title">
          <ScenarioIcon id={scenario.id} />
          {scenario.name}
        </div>
        <p>{scenario.blurb}</p>
      </div>

      <nav className="side-list">
        {scenario.surfaces.map((s, i) => (
          <a
            key={s.id}
            href={`/showcase/${scenario.id}/${s.id}`}
            className="side-item"
            data-active={s.id === surfaceId}
          >
            <span className="side-idx">{String(i + 1).padStart(2, "0")}</span>
            <span className="side-body">
              <b>{s.name}</b>
              <span>{s.persona}</span>
            </span>
          </a>
        ))}
      </nav>

      <div className="side-foot">
        {scenario.surfaces.some((s) => s.capabilities.includes("human-approval")) ? (
          <a href="/operator">
            改动审批台
            <span>↗</span>
          </a>
        ) : null}
        <span>更多场景陆续加入</span>
      </div>
    </aside>
  );
}

export function Footer({ compact = false }: { compact?: boolean }) {
  return (
    <footer className="footer" data-compact={compact}>
      <span>AgentHub Showcase</span>
      <span>
        源码 <code>kanyun-ai-explore/agenthub-showcase</code> · Agent 定义在 <code>agenthub/agents/</code>
      </span>
      <span>商品、订单、课程为演示用固定数据</span>
    </footer>
  );
}
