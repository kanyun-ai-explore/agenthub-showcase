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
