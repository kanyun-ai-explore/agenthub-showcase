/**
 * 「团队群」回放的剧本（原型）。
 *
 * 剧本是数据：每一步带绝对时刻（毫秒，从回放开始算），页面按一个时钟把它画出来（`replay.ts` 的
 * `frameAt`）。换内容只改这个文件，引擎和界面不动。
 *
 * ## 这是目标形态的示意
 *
 * 四幕画的是我们希望 agent 在团队的 Slack 群里做到的事，不是线上记录，也不按现在线上的能力边界写。
 * 人名、频道名、服务名、版本号、PR 号和读数都是为这份剧本编的。只有两处用的是产品里现成的文案：
 * 插话第一行的斜体提示，和 Stop 之后的「已停止。」。
 *
 * ## 分寸
 *
 * - 可以撤销的小动作（给一条告警加静音）直接做，做完报告，回执上留撤销。
 * - 改线上的动作（合并、回滚）先发确认卡，有人点了批准才执行。
 * - 斜体提示只出现在旁听插话那一条上。第四幕是它自己发现故障后发的消息，不算插话。
 *
 * ## 不画的
 *
 * 开口前先问「要不要我帮忙」；解释自己为什么没插话（旁注是回放的旁白，不是 bot 说的）；一分钟内
 * 连续插话。
 */

export type HumanId = "a" | "b";

export interface Human {
  name: string;
  initial: string;
  /** 头像底色。 */
  color: string;
}

export const HUMANS: Record<HumanId, Human> = {
  a: { name: "小林", initial: "林", color: "#2c7a7b" },
  b: { name: "阿远", initial: "远", color: "#b7791f" },
};

/** bot 在群里的显示名：占位，名字还没定。 */
export const BOT_NAME = "团队 agent";

/** 一位成员点了界面上的按钮，`at` 是按下的时刻。 */
export interface Tap {
  by: HumanId;
  at: number;
}

/** bot 消息下面挂的卡片，照 Slack 应用消息里的卡片画。 */
export type Block =
  /** 回执：已经做完的动作，或者一组读数。`undo` 是回执上的撤销按钮，回放里没有人去点。 */
  | { kind: "receipt"; title: string; rows: [string, string][]; undo?: string }
  /** PR 链接的展开。检查在 `passAt` 之前是运行中，之后是通过。 */
  | { kind: "pr"; number: string; title: string; repo: string; passAt: number }
  /** 确认卡：两个按钮。`tap` 是谁在什么时刻点了批准，`clock` 是批准后卡上显示的钟点。 */
  | { kind: "confirm"; title: string; rows: [string, string][]; approve: string; deny: string; tap: Tap; clock: string };

/**
 * 文字里的标记：`**粗体**`、`` `代码` ``、`[[链接]]`、整行 `_斜体_`、`<@a>` `<@b>` `<@bot>` 是 @。
 * `thread` 是所在线程的根消息 id；不带就是发在频道顶层。
 */
export type Step =
  | { kind: "typing"; who: HumanId; from: number; to: number }
  | {
      kind: "message";
      id: string;
      at: number;
      who: HumanId;
      clock: string;
      text: string;
      thread?: string;
      /** bot 在这条消息上加 :eyes: 的时刻（回合开始的回执）。 */
      eyesAt?: number;
    }
  | { kind: "bot"; id: string; at: number; clock: string; text: string; thread?: string; block?: Block }
  /**
   * 线程底部的进度状态和 Stop：回合进行中才有。`to` 是回复送达、状态消失的时刻；被 Stop 的以
   * `stop.at` 为准。
   */
  | { kind: "status"; id: string; from: number; to: number; thread: string; text: string; stop?: Tap }
  /**
   * 回放旁注：回放加的旁白，不是 Slack 的界面，也不是 bot 说的话。
   * 带 `decideAt` 的先显示「在旁听」，到点给出结果。
   */
  | { kind: "note"; id: string; at: number; decideAt?: number; tone: "quiet" | "speak" | "plain"; text: string };

export interface Act {
  id: string;
  at: number;
  /** 播放条上的短名。 */
  short: string;
  title: string;
  /** 这一幕里它替团队做了什么（右栏的说明）。 */
  look: string;
}

export interface ReplayScript {
  channel: string;
  acts: Act[];
  steps: Step[];
  end: number;
}

export const TEAM_CHAT_SCRIPT: ReplayScript = {
  channel: "dev-team",
  acts: [
    {
      id: "act",
      at: 0,
      short: "直接动手",
      title: "没人 @ 它，它也接得住",
      look: "有人在群里抱怨一条告警反复响，没有 @ 它。它查完历史，判断是噪音，把这条告警静音两小时，读数和回执发在线程里。和它无关的闲聊，它不出声。",
    },
    {
      id: "merge",
      at: 17500,
      short: "提 PR",
      title: "改线上的事，它做到确认那一步停下",
      look: "成员说阈值该改，它改好规则文件、提了 PR。合并会改线上的规则，所以它先发确认，有人批准后才合并。",
    },
    {
      id: "stop",
      at: 36500,
      short: "被打断",
      title: "说停就停",
      look: "交代的事范围太大，成员点了 Stop，它马上停下。把范围说小，它在同一个线程里接着做。",
    },
    {
      id: "rollback",
      at: 52500,
      short: "回滚",
      title: "出了故障，回滚只等一句批准",
      look: "发布后错误率上升，它把判断和回滚方案摆出来。有人批准后，它回滚到上一个版本，再报恢复后的读数。",
    },
  ],
  steps: [
    // ① 旁听，该它管的事直接动手。开头两句和它无关，它不动。
    { kind: "typing", who: "b", from: 400, to: 1400 },
    { kind: "message", id: "m1", at: 1400, who: "b", clock: "14:02", text: "<@a> 评审改到三点了" },
    { kind: "typing", who: "a", from: 1900, to: 2600 },
    { kind: "message", id: "m2", at: 2600, who: "a", clock: "14:02", text: "好" },
    { kind: "note", id: "n1", at: 3100, decideAt: 4200, tone: "quiet", text: "这两条和它无关，它没有开口" },
    { kind: "typing", who: "a", from: 5200, to: 6800 },
    {
      kind: "message",
      id: "m3",
      at: 6800,
      who: "a",
      clock: "14:05",
      text: "checkout-api 那条 P95 告警又响了，今天第 6 次，每次都是自己好的",
      eyesAt: 8600,
    },
    { kind: "note", id: "n2", at: 7300, decideAt: 8300, tone: "speak", text: "没有人 @ 它，它判断这件事该它管" },
    { kind: "status", id: "s1", from: 8900, to: 12400, thread: "m3", text: "正在查这条告警的历史…" },
    {
      kind: "bot",
      id: "b1",
      at: 12400,
      clock: "14:06",
      thread: "m3",
      text: [
        "_旁听插话 · 不需要可以 @我 说「安静」_",
        "查了：6 次都在 2 分钟内自己恢复，P95 峰值 820 ms，阈值 800 ms，错误率没动。是阈值贴着日常峰值，不是故障。",
        "我先把它静音了。",
      ].join("\n"),
      block: {
        kind: "receipt",
        title: "已静音",
        rows: [
          ["告警", "checkout-api P95 延迟"],
          ["时长", "2 小时，16:06 自动解除"],
        ],
        undo: "撤销",
      },
    },

    // ② 提 PR，确认后合并（同一线程，不用 @）
    { kind: "typing", who: "b", from: 17700, to: 19300 },
    {
      kind: "message",
      id: "m4",
      at: 19300,
      who: "b",
      clock: "14:08",
      thread: "m3",
      text: "阈值本来就该改，800 贴着峰值，调到 1000 吧",
      eyesAt: 19700,
    },
    { kind: "status", id: "s2", from: 19900, to: 22600, thread: "m3", text: "正在改规则文件、提 PR…" },
    {
      kind: "bot",
      id: "b2",
      at: 22600,
      clock: "14:10",
      thread: "m3",
      text: "提好了，检查在跑。",
      block: { kind: "pr", number: "#482", title: "告警：checkout-api P95 阈值 800 → 1000 ms", repo: "alert-rules", passAt: 25400 },
    },
    {
      kind: "bot",
      id: "b3",
      at: 26200,
      clock: "14:13",
      thread: "m3",
      text: "检查过了。合并会改线上的告警规则，要有人确认。",
      block: {
        kind: "confirm",
        title: "合并 PR #482",
        rows: [
          ["改动", "P95 阈值 800 → 1000 ms"],
          ["生效", "合并后约 2 分钟"],
        ],
        approve: "批准合并",
        deny: "拒绝",
        tap: { by: "b", at: 29400 },
        clock: "14:14",
      },
    },
    { kind: "status", id: "s3", from: 30100, to: 32400, thread: "m3", text: "正在合并…" },
    { kind: "bot", id: "b4", at: 32400, clock: "14:14", thread: "m3", text: "已合并，新阈值生效了。刚才的静音我撤掉了。" },

    // ③ 说停就停
    { kind: "typing", who: "a", from: 36700, to: 38300 },
    { kind: "message", id: "m5", at: 38300, who: "a", clock: "14:30", text: "<@bot> 其他服务的 P95 告警也照这个思路调一遍", eyesAt: 38700 },
    { kind: "status", id: "s4", from: 38900, to: 42300, thread: "m5", text: "正在整理 23 条规则…", stop: { by: "a", at: 42300 } },
    { kind: "bot", id: "b5", at: 43000, clock: "14:30", thread: "m5", text: "已停止。一条规则都还没改。" },
    { kind: "typing", who: "a", from: 43800, to: 45300 },
    { kind: "message", id: "m6", at: 45300, who: "a", clock: "14:31", thread: "m5", text: "范围太大了，只调支付这组的 3 条", eyesAt: 45700 },
    { kind: "status", id: "s5", from: 45900, to: 48600, thread: "m5", text: "正在改 3 条规则…" },
    { kind: "bot", id: "b6", at: 48600, clock: "14:33", thread: "m5", text: "改好了，3 条都在 [[PR #483]]，合并照旧等人确认。" },

    // ④ 故障：先发现，确认后回滚。b7 是它自己发在频道顶层的，不是插话，没有斜体提示。
    { kind: "note", id: "n3", at: 52700, tone: "plain", text: "两小时后，还没有人发现问题" },
    {
      kind: "bot",
      id: "b7",
      at: 54300,
      clock: "16:42",
      text: [
        "🔴 **checkout-api 错误率 0.2% → 7.4%**",
        "从 16:39 发布 v2.31.0 开始，报错集中在这一版新加的支付路径。判断是新版本引起的，建议回滚。",
      ].join("\n"),
      block: {
        kind: "confirm",
        title: "回滚 checkout-api（生产）",
        rows: [
          ["现在", "v2.31.0"],
          ["回到", "v2.30.4，上一个稳定版"],
        ],
        approve: "批准回滚",
        deny: "先不动",
        tap: { by: "a", at: 60200 },
        clock: "16:43",
      },
    },
    { kind: "typing", who: "b", from: 56300, to: 57800 },
    { kind: "message", id: "m7", at: 57800, who: "b", clock: "16:43", thread: "b7", text: "刚想问，支付页在报错" },
    { kind: "status", id: "s6", from: 60900, to: 64300, thread: "b7", text: "正在回滚到 v2.30.4…" },
    {
      kind: "bot",
      id: "b8",
      at: 64300,
      clock: "16:44",
      thread: "b7",
      text: "已回滚到 v2.30.4，用时 48 秒。事故记录建好了，复盘草稿稍后发到这里。",
      block: {
        kind: "receipt",
        title: "恢复读数",
        rows: [
          ["错误率", "7.4% → 0.2%"],
          ["P95", "1.9 s → 310 ms"],
          ["支付成功率", "91% → 99.6%"],
        ],
      },
    },
  ],
  end: 70000,
};
