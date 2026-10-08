# 闯关式课程：单元 1–2 大纲

本目录的 `u1.json`、`u2.json` 照这份大纲写，所有学员看到的题一样，写死在前端；单元 3 在上课过程中生成，不在这里。

- 难度：CEFR B1 起点。词汇控制在约 1500–2000 词的常用范围；目标词有没有超出 B1，由独立复核按词表判。
- 受众：青少年和成人。题面指令、`hint`、`explain` 用中文；练习内容（听的、拼的、填的、读的）用英文。
- 内容由 LLM 预生成，先过 `scripts/course-units/check.mjs` 机械核对，再由独立 agent 按 CEFR B1 词表和语法点逐关复核，再人工抽查 2 关。

## 单元与关卡

### 单元 1　出门旅行（u1）

| 关 | 标题 | 语法点 | 话题 | 目标词 |
|---|---|---|---|---|
| u1-l1 | 计划一次旅行 | 将来时：be going to（已经定好的计划）和 will（临时决定、预测） | 计划假期 | trip, abroad, book（订）, flight, hotel, passport, holiday, plan |
| u1-l2 | 在机场 | 情态动词：must / have to（必须）、can / can't（可以、不可以） | 值机、安检、登机 | check（托运）, luggage, boarding pass, gate, security, delay, departure, seat |
| u1-l3 | 旅途见闻 | 一般过去时：规则变化和常见不规则动词（went, took, saw, bought, lost, met） | 讲一次旅行 | arrive, miss（错过）, museum, beach, souvenir, guide, visit, map |
| u1-l4 | 你去过吗 | 现在完成时表经历：ever / never / already / yet；有具体时间点就用一般过去时 | 旅行经历 | ever, never, already, yet, been, try（尝试）, local, culture |
| u1-l5 | 单元复习：在酒店 | 复习本单元四个语法点，加礼貌请求 Could you … ? / I'd like … | 入住、退房、提要求 | reception, reservation, check out, towel, view, key, problem, receptionist |

### 单元 2　生活和工作（u2）

| 关 | 标题 | 语法点 | 话题 | 目标词 |
|---|---|---|---|---|
| u2-l1 | 买东西比一比 | 比较级和最高级：cheaper / more comfortable / the best；as … as | 买衣服、比价格 | price, size, try on, sale, comfortable, expensive, jacket, shirt |
| u2-l2 | 看病 | 情态动词 should / shouldn't 给建议；have a + 症状 | 看医生、买药 | headache, fever, cough, sore throat, medicine, appointment, rest, pharmacy |
| u2-l3 | 工作安排 | 现在进行时表已约好的安排；will 表主动提出（I'll send it.） | 开会、约时间 | meeting, colleague, manager, report, available, email, client, printer |
| u2-l4 | 求职面试 | 现在完成时 + for / since；How long have you … ? | 面试、讲经历 | job, apply, experience, salary, sales, since, for；skill, interview 只在选项里出现 |
| u2-l5 | 单元复习：忙碌的一周 | 复习本单元四个语法点 | 日常生活：作息、运动、健康 | weekend, gym, healthy, busy, diet, early, sleep, tennis |

目标词以题里实际出现的为准（写题时按能出成唯一答案的句子调过，上表已同步）。两个单元合起来覆盖这些语法点：一般过去时（u1-l3）、现在完成时（u1-l4、u2-l4）、比较级（u2-l1）、情态动词（u1-l2、u2-l2、u1-l5 的 could）、将来时（u1-l1、u2-l3）。

## 每关怎么出

- 每关 8 题，四种题型各 2 道（听音选词 2、拼句 2、填空 2、跟读 2），同一种不相邻；顺序由易到难，前两道练这一关的基础词，后面到整句。
- 听音选词（`listen_choice`）：`audio_text` 是一个短语或短句（最多 6 个词），`options` 3–4 个，其中**恰好一个**和 `audio_text` 逐词相同，其余是听上去接近的说法（如 `I've been` / `I've seen` / `I'd been`），不放同音词（念出来分不清）。
- 拼句（`word_bank`）：`prompt` 写「翻译成英文：<中文句>」；`answer` 是一整句，**每块一个词**、不带标点；`bank` = `answer` 的词打乱 + 1 个干扰词（共 6–8 块）。
- 填空（`fill_blank`）：`sentence` 只挖一个 `___`，`options` 3 个，只有一个在语法和语义上都成立。
- 跟读（`read_aloud`）：`text` 是 3–8 个词的一整句英文，带本关的目标词或语法点。
- `hint`：答错时先显示，指方向，**不含答案**。`explain`：答对后显示，一句话讲规则。两者都按 `Array.from(s).length ≤ 20` 计（汉字、字母、空格、标点都算一个），比「20 个汉字」更严。

## 数据格式

`u1.json` / `u2.json` 各一个单元：

```json
{
  "id": "u1",
  "title": "出门旅行",
  "levels": [
    {
      "lesson_id": "u1-l1",
      "title": "计划一次旅行",
      "focus": "be going to 和 will：计划和临时决定",
      "exercises": [
        { "type": "listen_choice", "audio_text": "…", "options": ["…"], "answer_index": 0, "prompt": "…", "hint": "…", "explain": "…" }
      ]
    }
  ]
}
```

- 每个 `levels[i]` 就是一次 `present_lesson` 的入参（`lesson_id` / `title` / `focus` / `exercises`），课程 v2 可以把它直接当一张 `lesson` 卡的 payload 交给 `lessonFromCards`。
- 每道题只用 `EXERCISE_FIELDS` 里该题型的字段，不加别的字段。
- `lesson_id` 沿用 `english-path.ts` 的关卡 id 写法（`u1-l1`）。它在页面上是进度存档的键，课程 v2 接入时是沿用还是换前缀还没定，这里先这样写。

## 和现有工具说明的两处差别

1. **拼句词块数**：`present_word_bank` 的说明写「两到六个词块」，那是给一年级启蒙写的。B1 的句子一般 6–8 个词，词块上限 6 就只能把几个词拼成一块（`have never`、`to Japan`），等于把语序提示给了学员。这里按「每块一个词、共 6–8 块」出。`normalizeExercise` 不限块数，现有页面能画。如果要守 6 块，就改成多词块。
2. **听音选词的 `audio_text`**：说明写「一个词或一个短语」，这里放到最多 6 个词的短句，好让选项之间只差一个音（`I've been` / `I'd been`），B1 的听辨在这一层上。

## 机械核对（`scripts/course-units/check.mjs`）

用法：`node --experimental-strip-types scripts/course-units/check.mjs`。

1. 信封：每关的入参先过 `present_lesson` 的 handler（MCP 侧整形），再过 `lessonFromCards`（前端取题）：`dropped` = 0，取出来的每道题和源文件逐字段相同（多字段、少字段都会被抓出来）；关卡、单元两层也不许有多余字段。前端只 trim `audio_text` 和跟读的 `text`，所以另有一条规则查所有字符串字段的首尾空白和连续空格。
2. 结构：每单元 5 关、`lesson_id` 依次是 `u1-l1` … ；每关 8 题、四种题型都有、同类不相邻；每题都有 `hint` 和 `explain`，长度不超 20；`hint` 里不出现答案；题面指令是中文；整个课程里同一道题不出两次。
3. 答案唯一：
   - 听音选词：恰好一个选项和 `audio_text` 逐词相同，就是 `answer_index` 那个；`audio_text` 不超过 6 个词；选项 3–4 个、两两不同；不放同音词（脚本带一张常见同音词表）。
   - 填空：只有一个 `___`，选项 3–4 个且两两不同。「只有一个选项成立」机器判不了，脚本把每个选项代进去的句子列给人工。
   - 拼句：`answer` 能由 `bank` 拼出、每块一个词、不带标点、6–8 块、恰好一个干扰词、`bank` 已打乱（从左往右点不出答案）。「没有第二种合法顺序」机器只能判一部分：答案里有可挪位置的成分（时间状语、频度副词、and / or / but）、或干扰词和答案里的某个词同族（同前缀、同为情态动词 / 助动词 / 介词 / 限定词）的，列给人工。
   - 跟读：3–8 个词。
4. 拼写：查题里所有英文，包括 `hint`、`explain`、题面里夹的英文。本机 `/usr/share/dict/web2` + `propernames`（约 23.6 万词）查词，查不到再按规则去掉屈折变化（-s / -es / -ed / -ing / -er / -est、`'s`、`n't` 等）查词根；还查不到的必须在 `scripts/course-units/allow-words.txt` 里逐个登记（写明为什么是对的），否则判失败，登记过的每次运行单列打印。已知盲区：拼成另一个真词的错（form / from）查不出来，留给独立复核。
5. 阳性对照：一关好题必须零报错；32 道坏题（覆盖 25 条规则）每道只坏一处，必须被对应的规则抓到。每次运行先跑这组对照，任何一道没抓到就退出 2（脚本自己坏了）。

退出码：0 = 全部通过（人工清单照常打印）；1 = 数据有错；2 = 阳性对照没抓到或读不到文件 / 词表。
