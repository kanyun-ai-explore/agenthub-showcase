/**
 * 把一轮已结束的对话拆成页面要渲染的三样东西：正文、展示卡片、工具轨迹。
 *
 * `CMA_UI_DELIVERY=result_text` 下 `present_*` 不往外发，信封就是工具自己的结果文本，
 * 所以卡片已经在这一轮里了，不需要沙箱反向打回浏览器。
 *
 * part 的形状是平台返回的 AI SDK UIMessage part（text / reasoning / dynamic-tool…）。
 */


/** One `present_*` envelope lifted out of a tool result, with the call that produced it. */
export interface TurnCard {
  /** Stable within a turn: the tool call id, so re-renders don't reshuffle. */
  id: string;
  /** Not narrowed to the known set on purpose — see `parseUiEnvelope`. */
  component: string;
  payload: unknown;
  /** The agent's own out-of-band remark, when its reply text ran past what the card shows. */
  notes?: string;
}

/** One tool the agent called, for the "what it actually did" strip. */
export interface TurnToolCall {
  id: string;
  name: string;
  /** `mcp__storefront__search_products` -> `search_products`; non-MCP tools keep their name. */
  shortName: string;
  input: unknown;
  failed: boolean;
}

export interface TurnRendering {
  /** The assistant's own message: `text` parts only. */
  replyText: string;
  cards: TurnCard[];
  toolCalls: TurnToolCall[];
  /** Reasoning parts, kept separate so the UI can hide them behind a toggle. */
  reasoning: string[];
}

/**
 * 今天有渲染实现的组件名。这张表不再决定「渲不渲染」——`displayed === true` 决定；
 * 手工维护的白名单一定会跟另一个包里的 Python 枚举漂移，漂移的代价是静默丢卡。
 */
const KNOWN_COMPONENTS: ReadonlySet<string> = new Set([
  // shopping
  "products",
  "comparison",
  "plan",
  "guide",
  "order_status",
  "checkout",
  // merchant
  "metrics",
  "digest",
  "change_preview",
  // 教育
  "course_plan",
  "trial_slots",
  "correction",
  "report",
  "slide",
  "exercise",
  // 通用
  "suggestions",
]);

export function isKnownComponent(component: string): boolean {
  return KNOWN_COMPONENTS.has(component);
}

interface RawPart {
  type?: string;
  text?: unknown;
  toolName?: unknown;
  toolCallId?: unknown;
  state?: unknown;
  input?: unknown;
  output?: unknown;
  errorText?: unknown;
}

/** reasoning part 也有 text 字段：按字段有无来判断，会把模型的思考当正文渲染出来。 */
function isTextPart(part: RawPart): boolean {
  return part.type === "text" && typeof part.text === "string";
}

function shortenToolName(name: string): string {
  // `mcp__<server>__<tool>` — keep the tool, drop the transport-level prefix.
  const match = /^mcp__[^_]+(?:_[^_]+)*__(.+)$/.exec(name);
  return match ? match[1] : name;
}

/** 解析成展示信封，普通工具结果返回 null。判据是 `displayed === true` ——
 * `search_products` 的结果也是 JSON，能解析不等于是卡片。 */
export interface UiEnvelope {
  component: string;
  payload: unknown;
  notes?: string;
  /** The turn's chips, when the component carried them (`PresentationPayload.suggestions`). */
  suggestions?: string[];
}

/** The cards one envelope renders as: the component, then its carried chips as a
 * `suggestions` card of its own — same card the standalone present_suggestions makes. */
export function cardsFromEnvelope(id: string, envelope: UiEnvelope): TurnCard[] {
  const { suggestions, ...card } = envelope;
  const cards: TurnCard[] = [{ id, ...card }];
  if (suggestions && suggestions.length > 0) {
    cards.push({ id: `${id}:suggestions`, component: "suggestions", payload: { suggestions } });
  }
  return cards;
}

export function parseUiEnvelope(output: unknown): UiEnvelope | null {
  if (typeof output !== "string") return null;
  const trimmed = output.trim();
  if (!trimmed.startsWith("{")) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;

  // FastMCP 会把 `-> str` 的返回值再包一层 `{"result": "<原文>"}`（教育 MCP 用的是
  // FastMCP，商城那个用低层 Server API 直接返回裸文本，两种都要认）。不剥这一层的话
  // `displayed` 判据落空，卡片被静默丢弃——正是之前 metrics 卡丢一天的那种形状。
  const wrapped = (parsed as { result?: unknown }).result;
  if (typeof wrapped === "string") {
    return parseUiEnvelope(wrapped);
  }
  const envelope = parsed as {
    displayed?: unknown;
    component?: unknown;
    payload?: unknown;
    notes?: unknown;
    suggestions?: unknown;
  };
  if (envelope.displayed !== true) return null;
  if (typeof envelope.component !== "string" || envelope.component.length === 0) return null;
  const suggestions = Array.isArray(envelope.suggestions)
    ? envelope.suggestions.filter((s): s is string => typeof s === "string" && s.length > 0)
    : [];
  return {
    component: envelope.component,
    payload: envelope.payload,
    ...(typeof envelope.notes === "string" && envelope.notes.length > 0 ? { notes: envelope.notes } : {}),
    ...(suggestions.length > 0 ? { suggestions } : {}),
  };
}

export function renderTurn(parts: readonly unknown[] | undefined): TurnRendering {
  const rendering: TurnRendering = { replyText: "", cards: [], toolCalls: [], reasoning: [] };
  if (!parts) return rendering;

  const texts: string[] = [];
  let anonymousCallSeq = 0;

  for (const raw of parts) {
    if (typeof raw !== "object" || raw === null) continue;
    const part = raw as RawPart;

    if (isTextPart(part)) {
      texts.push(part.text as string);
      continue;
    }
    if (part.type === "reasoning" && typeof part.text === "string") {
      rendering.reasoning.push(part.text);
      continue;
    }
    if (part.type !== "dynamic-tool" && part.type !== "tool") continue;

    const name = typeof part.toolName === "string" ? part.toolName : "(unnamed tool)";
    // A tool call with no id still needs a stable React key; fall back to its
    // position rather than reusing the name (the same tool is often called twice).
    const id = typeof part.toolCallId === "string" ? part.toolCallId : `call-${anonymousCallSeq++}`;
    rendering.toolCalls.push({
      id,
      name,
      shortName: shortenToolName(name),
      input: part.input,
      failed: part.state === "output-error" || typeof part.errorText === "string",
    });

    const envelope = parseUiEnvelope(part.output);
    if (envelope) rendering.cards.push(...cardsFromEnvelope(id, envelope));
  }

  // Join with a blank line: separate `text` parts are separate paragraphs the
  // model emitted around its tool calls, not one sentence split in half.
  rendering.replyText = texts.map((t) => t.trim()).filter(Boolean).join("\n\n");
  return rendering;
}
