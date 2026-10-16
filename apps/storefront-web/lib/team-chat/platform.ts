/**
 * 「团队群」右栏的代码面：每一幕在平台上要写哪几行、平台替你做了什么。
 *
 * ## 字段从哪来
 *
 * 这里的 yaml 是示意，没有对应的 agent 包，但每个字段都是平台协议里真有的：
 * - `channels[]` 的 slack 段、`inbound.mention / turnPolicy / sessionScope / ambient`：平台渠道（channels）
 *   的 agent.yaml 契约。
 * - `mcpServers[].tools[].approvalPolicy: always_ask`：平台的 MCP 工具审批。
 * - Slack App manifest 那几项：平台的 Slack 渠道接入说明。
 *
 * 值是占位：id 写成 `A0XXXXXXX`、`sec_…`、`vcrd_…`，工具名是读者自己那个 MCP 的，以它的 tools/list 为准。
 *
 * ## 要平台先开通的三样
 *
 * 示例里的 `type: slack`、`sessionScope`、`ambient` 要平台先开通。
 *
 * ## 只写平台现在有的
 *
 * `PLATFORM_DOES` 的每一句都要在平台协议里找得到。回放里画了、平台现在没有的（Slack 里点按钮批准、
 * 消息里的卡片、它自己先发现故障再开口），这里不写。
 */

/** `script.ts` 里四幕的 id。 */
export type ActId = "act" | "merge" | "stop" | "rollback";

/** 一段代码，和它对应的幕：回放走到这些幕时这一段点亮。 */
interface Chunk {
  acts: ActId[];
  text: string;
}

export interface CodeFile {
  title: string;
  chunks: Chunk[];
}

export const AGENT_YAML: CodeFile = {
  title: "agent.yaml",
  chunks: [
    {
      acts: [],
      text: `apiVersion: agenthub/v1alpha1
format: claude_code
modelService: model                  # 声明了 channels 就必须声明
model: deepseek-v4-flash
`,
    },
    {
      acts: ["act"],
      text: `channels:
  - name: team-slack
    type: slack
    slack:
      appId: A0XXXXXXX
      teamId: T0XXXXXXX
      botTokenSecretRef: sec_…       # 两把 token 存成平台密钥，不进沙箱
      appTokenSecretRef: sec_…
      allowGuests: false
    inbound:
      mention: required              # 频道里 @ 它才接
      turnPolicy: steer              # 它在忙的时候，新消息也收`,
    },
    {
      acts: ["merge", "stop", "rollback"],
      text: `      sessionScope: chat             # 一个线程是所有人共享的一个会话，跟进不用 @`,
    },
    {
      acts: ["act"],
      text: `      ambient:                       # 旁听没 @ 它的消息（试点，需平台开通）
        channels: [C0XXXXXXX]
        topics: [告警, 报错, 故障, 发版, 回滚]
`,
    },
    {
      acts: ["act", "merge", "rollback"],
      text: `mcpServers:
  - id: vcrd_…                       # 你登记的远程 MCP，工具名以它为准
    tools:`,
    },
    {
      acts: ["act"],
      text: `      - name: query_alert_history
      - name: silence_alert          # 没声明审批：直接执行`,
    },
    {
      acts: ["merge"],
      text: `      - name: open_pull_request
      - name: merge_pull_request
        approvalPolicy: always_ask   # 每次调用先挂起，有人同意才执行`,
    },
    {
      acts: ["rollback"],
      text: `      - name: rollback_release
        approvalPolicy: always_ask`,
    },
  ],
};

export const SLACK_MANIFEST: CodeFile = {
  title: "Slack App manifest（加这几项，线程里才有进度状态和 Stop）",
  chunks: [
    {
      acts: ["stop"],
      text: `features:
  agent_view:
    agent_description: 在 Slack 里处理 @ 它的请求
oauth_config:
  scopes:
    bot:
      - assistant:write              # 把 App 声明为 agent 会加上它
settings:
  event_subscriptions:
    bot_events:
      - agent_session_stopped        # 没有它，状态照样显示，但没有 Stop 按钮`,
    },
  ],
};

export function sourceOf(file: CodeFile): string {
  return file.chunks.map((chunk) => chunk.text).join("\n");
}

/** 这一幕在文件里点亮哪几段行（行号从 0 数，两端都含）。 */
export function marksOf(file: CodeFile, act: ActId): [number, number][] {
  const marks: [number, number][] = [];
  let line = 0;
  for (const chunk of file.chunks) {
    const count = chunk.text.split("\n").length;
    if (chunk.acts.includes(act)) marks.push([line, line + count - 1]);
    line += count;
  }
  return marks;
}

export interface PlatformDoes {
  act: ActId;
  name: string;
  blurb: string;
  /** 这件事由哪几个字段换来。 */
  evidence: string;
}

export const PLATFORM_DOES: PlatformDoes[] = [
  {
    act: "act",
    name: "判断要不要开口",
    blurb:
      "旁听频道里没 @ 它的消息，平台先用规则筛一遍：是不是问句、有没有提到故障、有没有命中你声明的话题词；@ 了别人的和太短的不算。筛出来的再调一次模型判断该不该开口，置信度不够就不出声。插话有频控，回在那条消息的线程里，第一行是固定提示。旁听还在试点：Slack 渠道、线程共享会话和旁听都要平台先开通。",
    evidence: "agent.yaml：channels[].inbound.ambient",
  },
  {
    act: "merge",
    name: "把要紧的调用拦下来等人",
    blurb:
      "声明了 always_ask 的工具，每次调用都在平台网关挂成一张待审批的票，有人同意才执行，拒绝时 Agent 收到拒绝理由。今天在控制台的会话页或经 API 同意，Slack 线程里还没有待审批的提示。MCP 的凭据由网关注入，Agent 在沙箱里读不到。",
    evidence: "agent.yaml：mcpServers[].tools[].approvalPolicy: always_ask",
  },
  {
    act: "stop",
    name: "随时能叫停",
    blurb: "回合进行中，线程底部一直有「处理中」状态和 Stop，线程里谁都能点。点了之后正在跑的任务被中止，还在排队的消息不再执行。",
    evidence: "Slack App manifest：agent_view · agent_session_stopped",
  },
  {
    act: "rollback",
    name: "凭据不落地，过程留痕",
    blurb:
      "Slack 的两把 token 存成平台密钥，只在平台建连接时解密，不进沙箱，也不进 git。一个线程对应平台上的一个会话，每轮的输入输出、工具调用和审批票都记在会话里，可以在控制台回看。",
    evidence: "agent.yaml：botTokenSecretRef · appTokenSecretRef（delivery: platform）",
  },
];

/** 把它跑起来要做的三件事，出处同文件头。 */
export const SETUP_STEPS: { title: string; body: string }[] = [
  {
    title: "建一个 Slack App",
    body: "用 Socket Mode，不用公网回调地址。把 bot token 和 app token 各存成一条平台投递的密钥，agent.yaml 里只写 sec_ 引用。",
  },
  {
    title: "登记你的 MCP",
    body: "告警、代码仓库、发布这些接口包成一个远程 MCP，在控制台登记后拿到 vcrd_ 引用。凭据填在登记表单里，由网关在调用时注入。",
  },
  {
    title: "提交 agent.yaml 和 CLAUDE.md",
    body: "什么事直接做、什么事先问人，写在 CLAUDE.md 里；哪些工具必须过审批，写在 agent.yaml 里。进默认分支后流水线发布，再把机器人邀请进频道。",
  },
];
