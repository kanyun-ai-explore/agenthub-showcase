/**
 * 回合音频「边合成边播」：段 0 一就绪就开始放，后面的段按序号接着放，不等整句合成完。
 *
 * 为什么不再用 `waitForTurnAudio`（`turn-audio?wait=1`）：它要等音频**整体**离开 `pending`
 * 才返回，页面就得等最后一段合成完才出声；平台的读接口在 `pending` 时已经把就绪的段带回来了
 * （SDK `getTurnAudio` 的注释：「start playing segment 0 while the rest is still being
 * synthesized」）。实测：生产上情景对话一回合里这一段加上终态轮询约 0.5–1.3 s。
 *
 * 这个模块是**纯逻辑**：读、播、睡、取时钟都由调用方注入（页面接 `fetch` + `<audio>`，
 * `scripts/roleplay-stream/check.mjs` 接假的），所以顺序、失败、回落这几种情形能脱离浏览器
 * 逐条跑。两条循环：
 *
 * - **读**：轮询读接口。还没有音频（404，合成要等首个正文才触发）时每 `idlePollMs` 读一次，
 *   `wake()` 可以提前读一次（页面在首个正文到达时叫它）；合成开始后、或回合已到终态时每
 *   `pollMs` 读一次。读到 `ready` / `failed` 就停（段已经全知道了），回合失败
 *   （`settle(false)`）、终态后 404 超过宽限、终态后满 `deadlineMs`、或起跑后满 `maxWaitMs`（终态一直
 *   不来时的保险）也停；播那一边收尾了（放完、被拦、被取消）读也跟着停。
 * - **播**：段 k 播完（或失败跳过）后找 k+1。`pending` 时 k+1 还没到就等——平台是并发合成，
 *   k+2 可能先于 k+1 就绪，不能跳着放；读那一边**停了**（终态或到上限）就不再等，有什么放
 *   什么，缺的段记进 `skipped`。
 *
 * 单段放不出来（`<audio>` 报错）跳过它接着放下一段——平台那边一段合成失败后不再起后面的段
 * （平台的合成实现如此），所以线上「中间失败」表现为
 * `failed` 加一部分段，照放已有的就对。**自动播放被浏览器拦下**（`blocked`）不跳：跳过去
 * 只会把整句静默地「播完」，页面得停下来给「再点一次」。
 */

/** 读接口给的一段：序号 + 短时签名 URL（平台 600 s 有效）。 */
export interface PlayerSegment {
  index: number;
  url: string;
}

/** 读一次的结果。`not_found` 与 `error` 分开：前者是「还没有」，后者是这一次没读成。 */
export type AudioRead =
  | {
      kind: "audio";
      status: "pending" | "ready" | "failed";
      /** 已就绪的段，按序号升序（可能有缺口：并发合成里后面的段先好了）。 */
      segments: PlayerSegment[];
      /** 平台 `failure.reason`（只在 `failed` 时有）。 */
      failure?: string;
    }
  /** 404 `TURN_AUDIO_NOT_FOUND`：合成还没触发，或这一版 agent 没有 `voice.output`。 */
  | { kind: "not_found" }
  /** 网络错误、5xx、被挡板拒——下一次照读，不当成结论。 */
  | { kind: "error"; code?: string };

/** 一段的播放结果。 */
export type SegmentPlayResult = "ended" | "error" | "blocked" | "cancelled";

export type PlaybackStatus =
  /** 每一段都放完了。 */
  | "played"
  /** 放了一部分：有段放不出来、或平台合成中途失败、或到上限时还有段没到。 */
  | "partial"
  /** 平台合成失败，一段都没有。 */
  | "failed"
  /** 回合终态之后过了宽限还是 404：这一轮没有音频。 */
  | "none"
  /** 到总时长上限一段都没等到。 */
  | "pending"
  /** 浏览器拦了自动播放。 */
  | "blocked"
  /** 回合失败了（`settle(false)`），不再等音频，一段都没有。不是「没声明 voice.output」。 */
  | "turn_failed"
  /** 调用方取消了（学员按住说话、又点了一次重听、页面卸载）。 */
  | "cancelled";

export interface PlaybackOutcome {
  status: PlaybackStatus;
  /** 放完的段序号，按播放顺序。 */
  played: number[];
  /** 没放出来的段序号（放的时候报错，或终态时还缺着）。 */
  skipped: number[];
  /** 平台 `failure.reason`，或最后一次读失败的错误码。 */
  code?: string;
  /** 一共读了几次读接口（每会话请求频率的口径从这里来）。 */
  reads: number;
}

export interface PlayerDeps {
  read: () => Promise<AudioRead>;
  /** 放一段，放完 / 放不出来 / 被取消时 resolve；`signal` 取消时要停下并回 `cancelled`。 */
  play: (segment: PlayerSegment, signal: AbortSignal) => Promise<SegmentPlayResult>;
  sleep: (ms: number) => Promise<void>;
  now: () => number;
}

export interface PlayerOptions {
  /** 合成已经开始、或回合已到终态时的轮询间隔。 */
  pollMs?: number;
  /** 还没有音频（404）、回合也没到终态时的轮询间隔。 */
  idlePollMs?: number;
  /**
   * 读那一边的上限，**从回合终态算**（起跑时已终态就从起跑算）。到了就停读，有什么放什么。
   * 不从起跑算：语音回合在 voice-turn 回包时就起跑，回合本身可能比这个上限还慢。
   */
  deadlineMs?: number;
  /** 终态一直不来时的保险上限（从起跑算）。正常路径上终态总会来（`turn-result` 轮询最多 200 s + 一次请求，`turn-result-poll.ts`）。 */
  maxWaitMs?: number;
  /** 回合终态之后仍 404 多久判「没有音频」。 */
  notFoundGraceMs?: number;
  /** 起跑时回合已经到了终态（重听、开场句）。 */
  settled?: boolean;
  /** 某一段第一次被读到（页面在这里记「段 0 就绪」）。 */
  onSegmentReady?: (index: number) => void;
}

export interface Playback {
  done: Promise<PlaybackOutcome>;
  cancel: () => void;
  /** 回合到了终态。`ok = false`（回合失败）时不再等音频：停读，已知的段照放。 */
  settle: (ok: boolean) => void;
  /** 有新线索（首个正文到了）：还在 404 阶段就立刻读一次，不等 `idlePollMs`。 */
  wake: () => void;
}

export const TURN_AUDIO_POLL_MS = 300;
export const TURN_AUDIO_IDLE_POLL_MS = 1000;
/** 总时长上限，从回合终态算。 */
export const TURN_AUDIO_DEADLINE_MS = 30_000;
/** 终态一直不来时的保险：比 `turn-result` 轮询的上限（200 s + 一次请求 20 s）再多一点。 */
export const TURN_AUDIO_MAX_WAIT_MS = 240_000;
export const TURN_AUDIO_NOT_FOUND_GRACE_MS = 5_000;

export function startTurnAudioPlayback(deps: PlayerDeps, options: PlayerOptions = {}): Playback {
  const pollMs = options.pollMs ?? TURN_AUDIO_POLL_MS;
  const idlePollMs = options.idlePollMs ?? TURN_AUDIO_IDLE_POLL_MS;
  const deadlineMs = options.deadlineMs ?? TURN_AUDIO_DEADLINE_MS;
  const maxWaitMs = options.maxWaitMs ?? TURN_AUDIO_MAX_WAIT_MS;
  const graceMs = options.notFoundGraceMs ?? TURN_AUDIO_NOT_FOUND_GRACE_MS;

  const startedAt = deps.now();
  let settledAt: number | null = options.settled ? startedAt : null;
  let turnFailed = false;
  let cancelled = false;
  /** 播那一边已经收尾：读不用再跑（被拦之后还读满上限）。 */
  let finished = false;
  const abort = new AbortController();

  /** 最近一次读到的音频（`kind: "audio"`）。 */
  let latest: Extract<AudioRead, { kind: "audio" }> | null = null;
  /** 读那一边停了：不会再有新的段。 */
  let readerDone = false;
  /** 读那一边为什么停（只在没读到音频时有意义）。 */
  let gaveUp: "none" | "deadline" | null = null;
  let lastErrorCode: string | undefined;
  let reads = 0;
  const seen = new Set<number>();

  let notifyPlayer: (() => void) | null = null;
  let cutSleep: (() => void) | null = null;

  const signalPlayer = () => {
    const resolve = notifyPlayer;
    notifyPlayer = null;
    resolve?.();
  };
  const waitForChange = () =>
    new Promise<void>((resolve) => {
      notifyPlayer = resolve;
    });
  /** 可以被 `wake()` / `cancel()` 提前叫醒的睡。 */
  const nap = (ms: number) =>
    new Promise<void>((resolve) => {
      let finished = false;
      const finish = () => {
        if (finished) return;
        finished = true;
        if (cutSleep === finish) cutSleep = null;
        resolve();
      };
      cutSleep = finish;
      void deps.sleep(ms).then(finish);
    });

  const readerLoop = async () => {
    while (!cancelled && !turnFailed && !finished) {
      const res = await deps.read();
      reads += 1;
      if (cancelled) break;
      if (res.kind === "audio") {
        latest = res;
        for (const segment of res.segments) {
          if (seen.has(segment.index)) continue;
          seen.add(segment.index);
          options.onSegmentReady?.(segment.index);
        }
        signalPlayer();
        // ready = 段已经全写完；failed = 平台不会再起后面的段。都不用再读了。
        if (res.status !== "pending") break;
      } else if (res.kind === "not_found") {
        if (latest === null && settledAt !== null && deps.now() - settledAt >= graceMs) {
          gaveUp = "none";
          break;
        }
      } else {
        lastErrorCode = res.code;
      }
      if (turnFailed || finished) break;
      const now = deps.now();
      if ((settledAt !== null && now - settledAt >= deadlineMs) || now - startedAt >= maxWaitMs) {
        gaveUp = "deadline";
        break;
      }
      await nap(latest !== null || settledAt !== null ? pollMs : idlePollMs);
    }
    readerDone = true;
    signalPlayer();
  };

  const playerLoop = async (): Promise<PlaybackOutcome> => {
    const played: number[] = [];
    const skipped: number[] = [];
    let last = -1;
    const finish = (status: PlaybackStatus, code?: string): PlaybackOutcome => ({
      status,
      played,
      skipped,
      ...(code ? { code } : {}),
      reads,
    });

    while (!cancelled) {
      const audio = latest as Extract<AudioRead, { kind: "audio" }> | null;
      // 不会再有新段了：读停了，或最近一次已经是终态。
      const final = readerDone || (audio !== null && audio.status !== "pending");
      const next = audio?.segments.filter((s) => s.index > last).sort((a, b) => a.index - b.index)[0];
      if (next && (next.index === last + 1 || final)) {
        for (let missing = last + 1; missing < next.index; missing += 1) skipped.push(missing);
        const result = await deps.play(next, abort.signal);
        if (cancelled || result === "cancelled") return finish("cancelled");
        if (result === "blocked") return finish("blocked");
        if (result === "ended") played.push(next.index);
        else skipped.push(next.index);
        last = next.index;
        continue;
      }
      if (final) break;
      await waitForChange();
    }
    if (cancelled) return finish("cancelled");

    const audio = latest as Extract<AudioRead, { kind: "audio" }> | null;
    if (played.length === 0 && skipped.length === 0) {
      if (audio?.status === "failed") return finish("failed", audio.failure);
      if (turnFailed) return finish("turn_failed");
      if (gaveUp === "none") return finish("none");
      return finish("pending", lastErrorCode);
    }
    if (skipped.length > 0 || audio?.status !== "ready") {
      return finish("partial", audio?.status === "failed" ? audio.failure : undefined);
    }
    return finish("played");
  };

  void readerLoop();
  const done = playerLoop().then((outcome) => {
    finished = true;
    cutSleep?.();
    return outcome;
  });

  return {
    done,
    cancel: () => {
      if (cancelled) return;
      cancelled = true;
      abort.abort();
      signalPlayer();
      cutSleep?.();
    },
    settle: (ok: boolean) => {
      if (settledAt === null) settledAt = deps.now();
      if (!ok) turnFailed = true;
      // 终态之后段马上就到（合成在终态那一步入队）：别让读那边还睡在 404 的长间隔里。
      if (!ok || latest === null) cutSleep?.();
    },
    wake: () => {
      if (latest === null) cutSleep?.();
    },
  };
}
