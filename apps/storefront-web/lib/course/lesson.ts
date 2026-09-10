import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { Lesson } from "./types";

/** 课件从 App 的固定数据读；agent 只给 slide_id，内容归这里。 */
export async function loadLesson(lessonId = "carry-addition"): Promise<Lesson> {
  const path = join(process.cwd(), "data", "course", `lesson-${lessonId}.json`);
  return JSON.parse(await readFile(path, "utf-8")) as Lesson;
}
