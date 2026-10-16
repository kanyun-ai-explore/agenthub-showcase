/**
 * 任意场景的任意视角。注册表是唯一决定这里存在什么的地方——加一个视角是
 * `lib/showcase/cases.ts` 加一条记录 + 一个手机端组件。
 *
 * 这一页锁定视口高度：顶栏、左栏、手机都固定，只有右边的解说栏滚动。
 */

import { notFound } from "next/navigation";
import type { Metadata } from "next";
import { CaseStage } from "@/components/showcase/CaseStage";
import { TeamChatStage } from "@/components/showcase/TeamChatStage";
import { SideNav, TopBar } from "@/components/showcase/Chrome";
import { isAgentHubConfigured } from "@/lib/agenthub/client";
import { catalogSeed } from "@/lib/showcase/catalog-seed";
import { loadLesson } from "@/lib/course/lesson";
import { lessonBackgroundAgent } from "@/lib/course/lesson-agent";
import { SCENARIOS, findScenario, findSurface } from "@/lib/showcase/cases";

export const dynamic = "force-dynamic";

export function generateStaticParams() {
  return SCENARIOS.flatMap((s) => s.surfaces.map((f) => ({ scenarioId: s.id, surface: [f.id] })));
}

type Params = Promise<{ scenarioId: string; surface?: string[] }>;

export async function generateMetadata({ params }: { params: Params }): Promise<Metadata> {
  const { scenarioId, surface } = await params;
  const scenario = findScenario(scenarioId);
  if (!scenario) return {};
  const chosen = findSurface(scenario, surface?.[0]);
  return { title: `${chosen.name} · ${scenario.name} · AgentHub Showcase`, description: chosen.tagline };
}

export default async function ScenarioPage({ params }: { params: Params }) {
  const { scenarioId, surface } = await params;
  const scenario = findScenario(scenarioId);
  if (!scenario) notFound();
  const chosen = findSurface(scenario, surface?.[0]);

  // 只有需要的视角才付出加载代价
  const catalog = chosen.app === "shopping" ? await catalogSeed() : undefined;
  const lesson = chosen.app === "classroom" ? await loadLesson() : undefined;
  // 英语小课单元 3 的后台出题走哪个 agent：环境变量只有这里读得到（本页 force-dynamic，每个请求都读）。没配是 undefined，
  // 第二个会话照旧建在 coach 上（`lib/course/lesson-agent.ts`）。
  const backgroundAgent = lessonBackgroundAgent(chosen.app, isAgentHubConfigured) ?? undefined;

  return (
    <div className="site" data-mode="app">
      <TopBar scenarioId={scenario.id} />
      <div className="frame">
        <SideNav scenario={scenario} surfaceId={chosen.id} />
        {/* 回放视角没有会话，不走 CaseStage（它一挂载就取访客身份、挂会话 hook）。 */}
        {chosen.app === "team-chat" ? (
          <TeamChatStage />
        ) : (
          <CaseStage scenario={scenario} surface={chosen} catalog={catalog} lesson={lesson} backgroundAgent={backgroundAgent} />
        )}
      </div>
    </div>
  );
}
