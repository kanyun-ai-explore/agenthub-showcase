/**
 * 课件的数据形状。
 *
 * 内容由 agent 现编：`present_slide` 传标题、正文、教具，`present_exercise` 传题目和
 * 选项，App 只负责画。原来是固定 8 页、agent 只能选页码——它想讲的和页面写的对不上，
 * 讲解就散了，而且换个知识点整套课件就得重写。
 *
 * 固定课件文件降级成「教学大纲」，agent 参考着推进，不照搬。
 */

export type SlideKind = "intro" | "concept" | "worked" | "practice" | "summary";

export type Visual =
  /** 实物图，emoji 由 agent 现挑（🍎🍬🦆⭐）。最直观，导入优先。 */
  | { type: "objects"; emoji: string; groups: number[] }
  /** 十格阵：小学一年级凑十法的标准教具，两组点子。 */
  | { type: "ten_frame"; frames: number[]; labels?: string[] }
  /** 数字分解图：整体拆成两部分。 */
  | { type: "number_bond"; whole: number; parts: number[]; caption?: string }
  /** 分步算式。 */
  | { type: "steps"; steps: string[]; captions?: string[] }
  | { type: "none" };

export interface Exercise {
  prompt: string;
  options: string[];
  answer_index: number;
  hint: string;
  explain: string;
}

export interface Slide {
  slide_id: string;
  kind: SlideKind;
  title: string;
  body: string;
  visual: Visual;
  exercise?: Exercise;
  /** 给老师看的备课提示，页面上不显示给学生。 */
  teacher_note?: string;
}

export interface Lesson {
  lesson_id: string;
  title: string;
  grade: string;
  knowledge_point: string;
  duration_min: number;
  objective: string;
  slides: Slide[];
}

/** 学生在一节课里的作答记录，用来算进度和给 agent 反馈。 */
export interface AnswerRecord {
  slide_id: string;
  chosen_index: number;
  correct: boolean;
  at: number;
}
