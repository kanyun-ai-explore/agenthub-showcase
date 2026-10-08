/**
 * 跟读的逐词比对（纯函数，页面里那个「绿=读对、红=读错、灰=漏读」就是它算的）。
 *
 * **不打发音分**：这里只见转写文本，没有音素、没有声调、没有重音，能判的
 * 只有「原句里的哪个词在孩子读出来的那句话里出现了、以什么形式出现」。比对结果偏乐观
 * 是刻意的已知代价——转写模型自己会顺手纠错（孩子念错一个音，它常按上下文给出正确
 * 的单词），所以页面上必须如实写出这一点，不假装它是评测。
 *
 * 判定用编辑距离的最短脚本，而不是「逐个位置比」：
 * - 漏读一个词（I would like a coffee → I like a coffee）该显示成**灰的 would**（漏读），
 *   而不是「从 would 起全部读错」。逐位比会给出后一种，孩子看到的是满屏红。
 * - 多读的词（转写里有、原句里没有）单独收进 `extra`，不占原句的位置。
 */

export type WordState = "right" | "wrong" | "missed";

export interface ComparedWord {
  /** 原句里的词，原样（大小写、标点都保留下来显示）。 */
  word: string;
  state: WordState;
}

export interface ReadingComparison {
  /** 原句逐词的对错，顺序与原句一致。 */
  words: ComparedWord[];
  /** 读对的词数 / 原句总词数。 */
  right: number;
  total: number;
  /** 孩子多读出来的词（转写里有、原句里没有）。 */
  extra: string[];
  /** 转写归一化之后的词序列，页面拿它显示「我听到的是…」。 */
  heard: string[];
  /** 「5 / 6 读对」——页面上那行字，算在这里免得两处口径漂移。 */
  summary: string;
}

/** 一个词：`text` 是它在原文里的样子（页面显示它），`word` 是归一化后用于比对的样子。 */
export interface WordToken {
  text: string;
  word: string;
}

/**
 * 切词：带词内分隔符（`-` `.` `'`）的串算**一个**词——`ice-cream`、`3.5`、`don't`
 * 在孩子眼里都是一个词，拆开会让孩子看到一个原句里并不存在的空档。
 * 句尾的标点（`. , ! ?`）不会被吸进来：分隔符后面必须还跟着字母数字。
 *
 * `text` 与 `word` 一一对应是这套比对的**前提**（颜色涂在词面上，判定跑在 `word` 上）：
 * 早先版本一边用「按空白切」的词面、一边用归一化切词的判定，遇到 `ice-cream` 这种词
 * 两边数量就对不上——颜色会涂到邻词上、还多出一个空词块。归一化只做两件事：小写、
 * 把弯引号折成直引号（`don’t` → `don't`）。
 */
export function tokenizeWords(text: string): WordToken[] {
  const tokens: WordToken[] = [];
  for (const match of text.matchAll(/[A-Za-z0-9]+(?:['’‘`.-][A-Za-z0-9]+)*/g)) {
    tokens.push({ text: match[0], word: match[0].toLowerCase().replace(/[’‘`]/g, "'") });
  }
  return tokens;
}

/** 归一化后的词序列（判定用）。 */
export function normalizeWords(text: string): string[] {
  return tokenizeWords(text).map((token) => token.word);
}

type Op =
  | { kind: "match" }
  | { kind: "sub" }
  | { kind: "del" }
  | { kind: "ins"; word: string };

/** 最短编辑脚本的 backtrack。平手时优先 match → sub → del → ins（读错的判定宁可保守）。 */
function editScript(target: string[], heard: string[]): Op[] {
  const n = target.length;
  const m = heard.length;
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = 0; i <= n; i += 1) dp[i][0] = i;
  for (let j = 0; j <= m; j += 1) dp[0][j] = j;
  for (let i = 1; i <= n; i += 1) {
    for (let j = 1; j <= m; j += 1) {
      const cost = target[i - 1] === heard[j - 1] ? 0 : 1;
      dp[i][j] = Math.min(
        dp[i - 1][j - 1] + cost,
        dp[i - 1][j] + 1,
        dp[i][j - 1] + 1,
      );
    }
  }

  const ops: Op[] = [];
  let i = n;
  let j = m;
  while (i > 0 && j > 0) {
    if (target[i - 1] === heard[j - 1] && dp[i][j] === dp[i - 1][j - 1]) {
      ops.push({ kind: "match" });
      i -= 1;
      j -= 1;
      continue;
    }
    if (dp[i][j] === dp[i - 1][j - 1] + 1) {
      ops.push({ kind: "sub" });
      i -= 1;
      j -= 1;
      continue;
    }
    if (dp[i][j] === dp[i - 1][j] + 1) {
      ops.push({ kind: "del" });
      i -= 1;
      continue;
    }
    ops.push({ kind: "ins", word: heard[j - 1] });
    j -= 1;
  }
  while (i > 0) {
    ops.push({ kind: "del" });
    i -= 1;
  }
  while (j > 0) {
    ops.push({ kind: "ins", word: heard[j - 1] });
    j -= 1;
  }
  ops.reverse();
  return ops;
}

/**
 * 把一句原句和孩子读出来的转写比成逐词的对错。
 *
 * `target` 用原始文本（词面原样显示），`heard` 传转写文本。
 */
export function compareReading(target: string, heard: string): ReadingComparison {
  // 词面与归一化词一一对应（见 tokenizeWords 的说明）：显示用的就是原句里的那段字。
  const targetTokens = tokenizeWords(target);
  const script = editScript(
    targetTokens.map((token) => token.word),
    normalizeWords(heard),
  );

  const words: ComparedWord[] = [];
  const extra: string[] = [];
  let right = 0;
  let index = 0;
  for (const op of script) {
    if (op.kind === "ins") {
      extra.push(op.word);
      continue;
    }
    const token = targetTokens[index];
    index += 1;
    if (!token) continue; // 脚本比词面长是 bug，宁可少画一格也不画一个空词块
    if (op.kind === "match") {
      right += 1;
      words.push({ word: token.text, state: "right" });
    } else if (op.kind === "sub") {
      words.push({ word: token.text, state: "wrong" });
    } else {
      words.push({ word: token.text, state: "missed" });
    }
  }
  for (; index < targetTokens.length; index += 1) {
    words.push({ word: targetTokens[index].text, state: "missed" });
  }

  const total = words.length;
  return {
    words,
    right,
    total,
    extra,
    heard: normalizeWords(heard),
    summary: `${right} / ${total} 读对`,
  };
}
