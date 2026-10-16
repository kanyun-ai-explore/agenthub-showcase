/**
 * 对拍的 TypeScript 一侧：直接调 `lib/course/mcp-tools.ts` 的 handler，打印各工具输出。
 *
 * 用 node 的 --experimental-strip-types 直接跑 .ts，不引编译步骤。
 * 用例集与 py_side.py **必须逐条对应**（同样的 key、同样的入参）。
 *
 * 用法（由 run.sh 调用）：
 *   cd apps/storefront-web && node --experimental-strip-types <此文件> "$PWD/lib/course/mcp-tools.ts"
 * cwd 必须是 apps/storefront-web——工具按 process.cwd()/data/course 找数据文件。
 */
const M = await import(process.argv[2]);
const byName = M.COURSE_TOOLS_BY_NAME;
const call = async (n, a = {}) => JSON.parse(await byName.get(n).handler(a));
// 校验失败的用例：两边比的是报错原文（TS 抛 Error、Python 抛 ValueError，各自取 message）。
const callError = async (n, a = {}) => {
  try {
    await byName.get(n).handler(a);
    return { error: null };
  } catch (err) {
    return { error: err.message };
  }
};
// present_lesson 的四类题混排，可选项有真值、空串、缺省三种（空串不该进 payload）。
const LESSON_MIXED = [
  { type: "listen_choice", audio_text: "tea", options: ["coffee", "tea", "milk"], answer_index: 1, prompt: "", hint: "开头是 t 的音", explain: "tea 是茶" },
  { type: "word_bank", prompt: "拼出：我想要一杯茶。", bank: ["tea", "I", "a", "like", "would"], answer: ["I", "would", "like", "a", "tea"], hint: "先找主语" },
  { type: "fill_blank", sentence: "I ___ a cake.", options: ["like", "likes"], answer_index: 0, explain: "I 后面用 like" },
  { type: "read_aloud", text: "Thank you very much", prompt: "跟我读：", hint: "", explain: "very much 加强语气", extra: "不认识的字段不进 payload" },
];
const out = {
  "get_lesson": await call("get_lesson"),
  "get_course_catalog": await call("get_course_catalog"),
  "get_trial_slots": await call("get_trial_slots"),
  "get_weekly_report@2026-08-10": await call("get_weekly_report", { week_of: "2026-08-10" }),
  "get_weekly_report@bogus": await call("get_weekly_report", { week_of: "not-a-date" }),
  "get_student_progress@stu-001": await call("get_student_progress", { student_id: "stu-001" }),
  "get_student_progress@stu-003": await call("get_student_progress", { student_id: "stu-003" }),
  "get_student_progress@missing": await call("get_student_progress", { student_id: "nope" }),
  "present_slide": await call("present_slide", { title: "标题", body: "正文", visual: { kind: "objects", emoji: "🍎", groups: [9, 4] }, kind: "intro", note: "备注" }),
  "present_exercise": await call("present_exercise", { prompt: "9+4=?", options: ["12", "13", "14"], answer_index: 1, hint: "先凑十", explain: "9+1=10" }),
  "present_listen_choice": await call("present_listen_choice", { audio_text: "coffee", options: ["coffee", "tea", "please"], answer_index: 0, prompt: "听一听，选出你听到的词", hint: "开头是 k 的音", explain: "coffee 是咖啡" }),
  "present_word_bank": await call("present_word_bank", { prompt: "把这句话翻译成英文：我想要一杯咖啡。", bank: ["I", "would", "like", "a", "coffee"], answer: ["I", "would", "like", "a", "coffee"], hint: "先找主语", explain: "would like 是「想要」" }),
  // 可选项全缺：空串不该被塞进 payload（两边都靠「真值才写」这条规则）
  "present_fill_blank@minimal": await call("present_fill_blank", { sentence: "I ___ a student.", options: ["am", "is", "are"], answer_index: 0 }),
  "present_read_aloud": await call("present_read_aloud", { text: "I would like a coffee please", prompt: "跟我读：", hint: "would like 连起来读", explain: "please 放句尾更礼貌" }),
  "present_read_aloud@minimal": await call("present_read_aloud", { text: "I like coffee." }),
  "present_lesson@mixed": await call("present_lesson", { title: "第 2 关", focus: "分清 tea 和 coffee", exercises: LESSON_MIXED }),
  "present_lesson@minimal": await call("present_lesson", { exercises: [{ type: "read_aloud", text: "I like milk." }] }),
  // 分批：第一批 2 道，带 lesson_id 与批次号；batch=0 不进 payload
  "present_lesson@batch": await call("present_lesson", { lesson_id: "u1-l1#3", batch: 1, batches: 2, exercises: LESSON_MIXED.slice(0, 2) }),
  "present_lesson@batch-zero": await call("present_lesson", { lesson_id: "", batch: 0, batches: 1, exercises: LESSON_MIXED.slice(3) }),
  "present_lesson@empty": await callError("present_lesson", { exercises: [] }),
  "present_lesson@too-long": await callError("present_lesson", { exercises: Array.from({ length: 13 }, () => ({ type: "read_aloud", text: "Hi" })) }),
  // 一次列全：缺字段 + 不认识的题型 + 不是对象，三条问题一条报错
  "present_lesson@invalid": await callError("present_lesson", { exercises: [
    { type: "listen_choice", audio_text: "tea", answer_index: null },
    { type: "matching", pairs: [] },
    "tea",
    { type: "read_aloud", text: "Hi" },
  ] }),
  "present_report": await call("present_report", { title: "周报", week_of: "2026-08-10",
      class_summary: { totalAttempts: 10, activeStudents: 3, accuracy: 0.5 },
      knowledge_points: [{ knowledgePoint: "x", avgDurationMs: 100 }],
      alerts: [{ knowledgePoint: "x", consecutiveWrong: 3 }],
      data_quality: { acceptedRows: 10, rejectedRows: 1 } }),
  "present_suggestions": await call("present_suggestions", { suggestions: ["再来一题", "换个例子"] }),
};
const sortKeys = (v) => Array.isArray(v) ? v.map(sortKeys)
  : (v && typeof v === "object") ? Object.fromEntries(Object.keys(v).sort().map(k => [k, sortKeys(v[k])])) : v;
process.stdout.write(JSON.stringify(sortKeys(out), null, 1) + "\n");
