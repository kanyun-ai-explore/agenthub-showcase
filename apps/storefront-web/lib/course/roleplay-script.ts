/**
 * 情景对话的对话稿：从会话消息里折出「店员一句 / 学员一句」交替的那一列。
 *
 * 从 `RoleplayApp` 里抽出来，是为了不靠 React 也能跑用例（`scripts/roleplay-stream/check.mjs`）：
 * 店员那句改成**边到边显示**之后，这里多了「流式中的半句也算一条」与「流断了回落到终态」
 * 两种情形，都要能逐条核。只用 `import type`，Node 的类型剥离直接 import 得动。
 *
 * ⚠️ 不能按消息顺序直接堆：语音路径上 agent 的**占位气泡先入列**（`dispatchVoice` 起点就
 * push 一条空的 agent 消息，给流式输出留位置），学员那一轮的转写是**回包之后**才补进去的。
 * 按顺序遍历会得到「店员 → 店员 → 学员」这种错位，配上对就是「上一句回下一句」。所以两份
 * 各自成列、按下标对齐：第 i 个学员的话 ⇄ 第 i+1 条店员的话（第 0 条是开场问候）。
 *
 * 流式那一条：正文 delta 一到（`useAgentConversation` 的 SSE 把它写进占位消息）就作为店员的
 * 一句出现，`streaming: true`；终态到了，同一条消息的正文被权威结果整句替换、`streaming`
 * 落成 false。流断了（`stream-error`、连不上）就只是 delta 不再来：已经画出来的半句留着，
 * 终态照样整句替换；一个 delta 都没到的话，这一句跟改之前一样到终态才出现。
 */

import type { Message } from "@/components/agent/useAgentConversation";

export interface ScriptTurn {
  role: "barista" | "student";
  text: string;
  /** 店员那句话的 turnId（取回合音频用；终态之后才有）。 */
  turnId?: string;
  /** 店员这句还在流式输出：正文还会变长，终态时整句替换。 */
  streaming?: boolean;
}

export function foldRoleplayScript(messages: readonly Message[], opener: string): ScriptTurn[] {
  const baristas: ScriptTurn[] = [];
  const students: string[] = [];
  for (const message of messages) {
    if (message.role === "user") {
      // 开场那句是页面替学员说的，不算他的一轮。
      if (message.text.trim() && message.text !== opener) students.push(message.text);
      continue;
    }
    if (message.role !== "agent") continue;
    // 失败的空壳、以及还没出正文的占位都不算一条台词（失败的那轮在语音路径上根本不会留下气泡）。
    if (message.failed || !message.text.trim()) continue;
    baristas.push({
      role: "barista",
      text: message.text.trim(),
      ...(message.turnId ? { turnId: message.turnId } : {}),
      ...(message.streaming ? { streaming: true } : {}),
    });
  }
  // 流式的那句先于学员的转写到（转写这一跳没读到、要等终态补）：先压住，等学员那句到了一起
  // 出——不然会短暂地画成「店员 → 店员」，学员那句再插到后面。
  const last = baristas.length - 1;
  if (last > 0 && baristas[last].streaming && students[last - 1] === undefined) baristas.pop();

  const out: ScriptTurn[] = [];
  for (let i = 0; i < baristas.length; i += 1) {
    if (i > 0 && students[i - 1] !== undefined) out.push({ role: "student", text: students[i - 1] });
    out.push(baristas[i]);
  }
  // 学员说了、店员还没回（正在生成或刚失败）：也要显示，不然那一句像丢了。
  for (let i = Math.max(baristas.length - 1, 0); i < students.length; i += 1) {
    out.push({ role: "student", text: students[i] });
  }
  return out;
}
