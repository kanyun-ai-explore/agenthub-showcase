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

/** 句型卡上的一行：英文原样 + 中文意思（孩子看得懂的那半）。 */
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
  /** 用到的场景词（咖啡店那几个名词/形容词）。 */
  words: string[];
  /** 说得最长的那一句（词数最多的一轮转写），没有就是 null。 */
  longest: string | null;
  /** 逐轮回顾，原样带出去。 */
  rounds: RoleplayRound[];
}

/**
 * 句型表。匹配的是**归一化之后**的转写（小写、去标点、单引号统一）。
 * 每条只认自己那一种说法：学员说 `I want …` 时不会点亮 `I would like …`——
 * 小结卡是在告诉孩子「这句话你会说了」，把没说的算成会说是这张卡最贵的错。
 */
const PATTERNS: { phrase: string; gloss: string; test: RegExp }[] = [
  { phrase: "I would like …", gloss: "我想要……", test: /\bi(?:'d| would) like\b/ },
  { phrase: "I want …", gloss: "我要……", test: /\bi want\b/ },
  { phrase: "Can I have …", gloss: "我可以要……吗", test: /\bcan i (?:have|get)\b/ },
  { phrase: "How much …", gloss: "多少钱", test: /\bhow much\b/ },
  { phrase: "here you are", gloss: "给你", test: /\bhere you (?:are|go)\b/ },
  { phrase: "please", gloss: "请", test: /\bplease\b/ },
  { phrase: "thank you", gloss: "谢谢", test: /\bthank you\b|\bthanks\b/ },
  { phrase: "hi / hello", gloss: "你好", test: /\b(?:hi|hello)\b/ },
  { phrase: "bye", gloss: "再见", test: /\b(?:bye|goodbye|see you)\b/ },
];

/** 咖啡店这一课点的词。只数学员自己说出来的，不数 agent 说的。 */
const SCENE_WORDS = [
  "coffee", "tea", "milk", "juice", "water", "cake", "cookie",
  "hot", "iced", "cold", "small", "big", "large",
] as const;

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
 * 1 轮没听清」比「说了 3 句」信息量大：没听清那轮往往才是孩子最想重来的那轮。
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
    for (const word of SCENE_WORDS) {
      if (new RegExp(`\\b${word}\\b`).test(normalized)) words.add(word);
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
