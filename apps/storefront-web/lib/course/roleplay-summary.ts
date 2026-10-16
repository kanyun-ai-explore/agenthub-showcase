/**
 * 情景对话的小结卡：**前端**从 3–4 轮的转写和回复里算出来的那几行。
 *
 * 为什么在前端算：三期用的 agent 是 `format: live`，它**调不了任何工具**（没有沙箱进程），
 * `present_*` 那条路根本不存在。所以小结不靠 agent 输出，只由这一层从对话本身数出来——
 * 数据来源就两样：平台对学员每段录音的**转写**（就是那一轮的 `user.text`），和 agent
 * 每一轮的**回复原文**。
 *
 * 口径：**不打分、不评发音**。转写模型会顺手把读音纠成正确的词，任何「读得
 * 准不准」的读数都是假的。这里能诚实地数是：说了几句、说了多少个词、用到了哪些句型、
 * 点到了哪些词。没听清的轮次单列（`missedTurns`），不算进「说了几句」。
 *
 * 纯函数、没有 DOM：`scripts/roleplay-summary/check.mjs` 直接 import 它跑用例。
 */

/** 一轮：学员说的话（转写）与 agent 回的话（原文）。 */
export interface RoleplayRound {
  transcript: string;
  reply: string;
}

/** 句型卡上的一行：英文原样 + 中文意思（学员看得懂的那半）。 */
export interface RoleplayPattern {
  phrase: string;
  gloss: string;
}

export interface RoleplaySummary {
  /** 学员真的说了话的轮数（转写非空）。 */
  studentTurns: number;
  /** 没听清的轮数（转写是空的）。 */
  missedTurns: number;
  /** 学员说出的英文词数（全部轮加起来）。 */
  spokenWords: number;
  /** 转写里出现中文的轮数——出现了不算错，只是这一轮没练到英文。 */
  nonEnglishTurns: number;
  /** 用到的句型（按下面的表逐条匹配，用不到的不出现）。 */
  patterns: RoleplayPattern[];
  /** 用到的场景词（饮品、点心和点单选项，见下面的 `SCENE_WORDS`）。 */
  words: string[];
  /** 说得最长的那一句（词数最多的一轮转写），没有就是 null。 */
  longest: string | null;
  /** 逐轮回顾，原样带出去。 */
  rounds: RoleplayRound[];
}

/**
 * 句型表：店员 Sam 的定义里「用词（B1 起点）」那一节的「句」一行
 * （`agenthub/agents/edu-english-roleplay/CLAUDE.md`），两边改一边要跟着改。
 * 匹配的是**归一化之后**的转写（小写、去标点、单引号统一）。
 * 每条只认自己那一种说法：学员说 `I want …` 时不会点亮 `I'd like …`——
 * 小结卡是在告诉学员「这句话你会说了」，把没说的算成会说是这张卡最贵的错。
 * 同一句只换情态动词（can / could）算同一种说法；`get` 和 `have` 各是各的。
 */
const PATTERNS: { phrase: string; gloss: string; test: RegExp }[] = [
  { phrase: "I'd like …", gloss: "我想要……", test: /\bi(?:'d| would) like\b/ },
  { phrase: "Can I get …", gloss: "给我来……", test: /\b(?:can|could) i get\b/ },
  { phrase: "Could I have …", gloss: "能给我……吗", test: /\b(?:could|can) i have\b/ },
  { phrase: "How much …?", gloss: "……多少钱？", test: /\bhow much\b/ },
  { phrase: "For here, please.", gloss: "在店里用。", test: /\bfor here\b/ },
  { phrase: "Can I pay by card?", gloss: "可以刷卡吗？", test: /\b(?:can|could) i pay by card\b/ },
];

/** 一个场景词：显示的词 + 在归一化转写里找它的式子（带 g：命中的那一段要挖掉）。 */
function sceneWord(word: string, test = new RegExp(`\\b${word}\\b`, "g")): { word: string; test: RegExp } {
  return { word, test };
}

/**
 * 场景词：同一节的「饮品和点心」「选项」两行。只数学员自己说出来的，不数 agent 说的。
 * 按表的顺序匹配，命中就从这一轮的转写里挖掉——所以多词的要排在它含的单词前面：
 * 说 `hot chocolate` 不顺带点亮 `hot`，说 `oat milk` 不顺带点亮 `milk`。
 * `for here` 不在这里：它是上面的一条句型。
 */
const SCENE_WORDS = [
  sceneWord("coffee"), sceneWord("latte"), sceneWord("cappuccino"), sceneWord("tea"),
  sceneWord("hot chocolate"), sceneWord("juice"), sceneWord("cake"), sceneWord("muffin"),
  sceneWord("croissant"), sceneWord("sandwich"),
  sceneWord("hot"), sceneWord("iced"), sceneWord("small"), sceneWord("medium"), sceneWord("large"),
  sceneWord("oat milk"), sceneWord("milk"), sceneWord("sugar"),
  // 「外带」的 to go；前面是 have / want / need / going / got 的是「得走了」「想去」，不算。
  sceneWord("to go", /(?<!\b(?:have|has|want|wants|need|needs|going|got) )\bto go\b/g),
];

/** 归一化：小写、弯引号拉直、去掉字母/单引号之外的一切、空白折叠。 */
export function normalizeTranscript(text: string): string {
  return text
    .toLowerCase()
    .replace(/[’‘`]/g, "'")
    .replace(/[^a-z'\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** 英文词数：归一化后按空白切，只要含字母就算一个词（数字与纯标点不算）。 */
export function countSpokenWords(text: string): number {
  return normalizeTranscript(text)
    .split(" ")
    .filter((token) => /[a-z]/.test(token)).length;
}

/** 转写里有没有中文——`nonEnglishTurns` 用的判据。 */
function hasChinese(text: string): boolean {
  return /[一-鿿]/.test(text);
}

/**
 * 从逐轮的 (转写, 回复) 算出小结卡的全部读数。
 *
 * 空轮（转写为空）不计入 `studentTurns`，但要计入 `missedTurns`——「有 3 轮听见了、
 * 1 轮没听清」比「说了 3 句」信息量大：没听清那轮往往才是学员最想重来的那轮。
 */
export function summarizeRoleplay(rounds: readonly RoleplayRound[]): RoleplaySummary {
  const patterns: RoleplayPattern[] = [];
  const words = new Set<string>();
  let studentTurns = 0;
  let missedTurns = 0;
  let spokenWords = 0;
  let nonEnglishTurns = 0;
  let longest: string | null = null;
  let longestWords = 0;

  for (const round of rounds) {
    const normalized = normalizeTranscript(round.transcript);
    const turnWords = countSpokenWords(round.transcript);
    if (turnWords === 0) {
      // 没有英文词：要么整轮空，要么说的是中文——两种都不是「说了一句英文」。
      if (round.transcript.trim() === "") missedTurns += 1;
      else nonEnglishTurns += 1;
    } else {
      studentTurns += 1;
      spokenWords += turnWords;
      if (turnWords > longestWords) {
        longestWords = turnWords;
        longest = round.transcript.trim();
      }
    }
    for (const pattern of PATTERNS) {
      if (!patterns.some((p) => p.phrase === pattern.phrase) && pattern.test.test(normalized)) {
        patterns.push({ phrase: pattern.phrase, gloss: pattern.gloss });
      }
    }
    let rest = normalized;
    for (const { word, test } of SCENE_WORDS) {
      const next = rest.replace(test, " ");
      if (next !== rest) {
        words.add(word);
        rest = next;
      }
    }
  }

  return {
    studentTurns,
    missedTurns,
    spokenWords,
    nonEnglishTurns,
    patterns,
    words: [...words],
    longest,
    rounds: [...rounds],
  };
}
