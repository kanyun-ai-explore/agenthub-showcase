/**
 * 英语小课单元 3 的后台出题，第二个会话建在哪个 agent 上。
 *
 * - 站点配了出题专用的 agent（key `english-lesson-gen`，环境变量 `AGENTHUB_ENGLISH_LESSON_GEN_AGENT_ID`）：
 *   第二个会话建在它上面。它只出题，不声明 voice，用不推理的模型——coach 的文字回合走模型网关上的 deepseek，
 *   关不掉推理，一个【出题】回合 p50 约 27 s，大半是推理。coach 的转写走它自己声明的百炼服务，和这里无关。
 * - 没配：返回 null，第二个会话照旧建在英语课自己的 agent（edu-english-coach）上，和改之前一样。站点可以先发、env 后配；
 *   清掉这个环境变量就是回滚。
 *
 * 配了、会话却建不起来（没有槽位、平台报错）不在这里管：第二个会话变成 error，`useLessonChannel` 往下退一级——
 * 出题 agent → 兜底的第二个 coach 会话 → 主会话（`demoteBackground`），兜底也建不起来才回到主会话排队。
 *
 * 环境变量只有服务端读得到：由页面（server component，`force-dynamic`，每个请求都读）算好传给 `CaseStage`。
 * 是否配置由调用方注入（页面传 `isAgentHubConfigured`），用例表直接喂函数。
 */

export const LESSON_GEN_AGENT = "english-lesson-gen";

export function lessonBackgroundAgent(
  app: string | undefined,
  isConfigured: (agent: string) => boolean,
): typeof LESSON_GEN_AGENT | null {
  return app === "english" && isConfigured(LESSON_GEN_AGENT) ? LESSON_GEN_AGENT : null;
}
