"use client";

/**
 * 读音：全部来自平台的语音能力，站点不直调模型网关。
 * - 单元 1、2：平台预生成的静态文件（`/course-audio/*.m4a`，清单见 `lib/course/course-audio.ts`）；
 * - 单元 3：运行时经 `/api/course/audio` 由朗读 agent 合成，浏览器只报题的坐标。
 * 一关的题一到手就把这一关要念的句子都预取成本地 blob（`prefetch`），作答时点喇叭直接放。
 *
 * 运行时那一句拿回来时，响应头 `X-Reader-Text` 是服务端念的那句：和题上的原文不一致就不收
 * （草稿和定稿在同一个下标上不是同一道题时，不放错音）。
 *
 * 取不到（没配朗读 agent / 平台没合成成 / 限速）就退到浏览器自带的 speechSynthesis，题上如实标出
 * 这次是「本机语音」。**正在取的那一句先等一会儿**（`INFLIGHT_WAIT_MS`）：
 * 单元 3 一关刚出好时它的读音还在合成，第一下就退本机语音的话，演示里出现「本机语音」的那一刻，
 * 平台的那一句其实几秒后就到。
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { staticClipSrc, type Clip } from "@/lib/course/course-audio";

export type TtsSource = "platform" | "browser";

/** 预取的并发：一关最多十来句，两条并发够快，也不至于一下子把站点的限速打满。 */
const PREFETCH_CONCURRENCY = 2;
/** 点喇叭时那一句还在取，最多等多久再退本机语音。朗读回合派发到段 0 约 2–3 s（实测）。 */
const INFLIGHT_WAIT_MS = 8_000;

function speakInBrowser(text: string): Promise<TtsSource> {
  return new Promise((resolve, reject) => {
    const synth = typeof window === "undefined" ? undefined : window.speechSynthesis;
    if (!synth) {
      reject(new Error("这个浏览器没有 speechSynthesis"));
      return;
    }
    const utterance = new SpeechSynthesisUtterance(text);
    utterance.lang = "en-US";
    utterance.rate = 0.9;
    utterance.onend = () => resolve("browser");
    utterance.onerror = () => reject(new Error("本机语音播放失败"));
    synth.cancel();
    synth.speak(utterance);
  });
}

/** 运行时那一句服务端念的是不是题上这一句（静态文件按原文查的，不用比）。 */
function sameText(res: Response, clip: Clip): boolean {
  if (clip.kind === "static") return true;
  const header = res.headers.get("X-Reader-Text");
  if (header === null) return false;
  try {
    return decodeURIComponent(header) === clip.text;
  } catch {
    return false;
  }
}

export function useSpeech() {
  /** 句子 → 这一句从哪取（预取时登记）。 */
  const clips = useRef(new Map<string, Clip>());
  /** 句子 → blob URL（取到了的）；同一句只取一次。 */
  const urls = useRef(new Map<string, string>());
  /** 句子 → 正在取的那次请求，预取和点击撞上时共用一个。 */
  const inflight = useRef(new Map<string, Promise<string | null>>());
  const audio = useRef<HTMLAudioElement | null>(null);
  const [speaking, setSpeaking] = useState<string | null>(null);
  const [source, setSource] = useState<TtsSource | null>(null);

  useEffect(
    () => () => {
      audio.current?.pause();
      for (const url of urls.current.values()) URL.revokeObjectURL(url);
      urls.current.clear();
    },
    [],
  );

  /** 取一句的音频，成功返回 blob URL，失败返回 null（调用方退到本机语音）。 */
  const fetchUrl = useCallback((clip: Clip): Promise<string | null> => {
    const cached = urls.current.get(clip.text);
    if (cached) return Promise.resolve(cached);
    const pending = inflight.current.get(clip.text);
    if (pending) return pending;
    if (!clip.src) return Promise.resolve(null);
    const src = clip.src;
    const request = (async () => {
      try {
        const res = await fetch(src);
        if (!res.ok || !sameText(res, clip)) return null;
        const blob = await res.blob();
        if (blob.size === 0) return null;
        const url = URL.createObjectURL(blob);
        urls.current.set(clip.text, url);
        return url;
      } catch {
        return null;
      } finally {
        inflight.current.delete(clip.text);
      }
    })();
    inflight.current.set(clip.text, request);
    return request;
  }, []);

  /** 登记并预取一关要念的句子。取不到的不重试——点的时候再取一次，或者退本机语音。 */
  const prefetch = useCallback(
    async (list: readonly Clip[]) => {
      for (const clip of list) {
        const known = clips.current.get(clip.text);
        // 后来的有地址的版本（单元 3 回合终态记下了出处）盖掉之前没地址的。
        if (!known || (!known.src && clip.src)) clips.current.set(clip.text, clip);
      }
      const todo = [...new Set(list.map((c) => c.text))]
        .map((text) => clips.current.get(text) as Clip)
        .filter((clip) => clip.src && !urls.current.has(clip.text));
      let next = 0;
      const worker = async () => {
        while (next < todo.length) {
          const clip = todo[next];
          next += 1;
          await fetchUrl(clip);
        }
      };
      await Promise.all(Array.from({ length: Math.min(PREFETCH_CONCURRENCY, todo.length) }, worker));
    },
    [fetchUrl],
  );

  /** 这一句该从哪取：预取时登记过的；没登记过的，是单元 1、2 的就查静态清单。 */
  const clipFor = useCallback((text: string): Clip => {
    const known = clips.current.get(text);
    if (known) return known;
    const src = staticClipSrc(text);
    return { text, src, kind: src ? "static" : "runtime" };
  }, []);

  /**
   * 等这一句的地址和音频，最多 `INFLIGHT_WAIT_MS`。单元 3 刚从草稿开出来的那一关还没记下出处（回合
   * 终态时才有），这时它的句子没有地址：先等地址登记上，再等音频，总共不超过上限。
   */
  const resolveUrl = useCallback(
    async (text: string): Promise<string | null> => {
      const deadline = Date.now() + INFLIGHT_WAIT_MS;
      for (;;) {
        const clip = clipFor(text);
        if (clip.src) {
          const left = Math.max(0, deadline - Date.now());
          return Promise.race([fetchUrl(clip), new Promise<null>((resolve) => setTimeout(() => resolve(null), left))]);
        }
        if (Date.now() >= deadline) return null;
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
    },
    [clipFor, fetchUrl],
  );

  const play = useCallback(
    async (text: string): Promise<void> => {
      if (!text) return;
      setSpeaking(text);
      try {
        const url = await resolveUrl(text);
        if (!url) throw new Error("platform audio unavailable");
        const el = audio.current ?? new Audio();
        audio.current = el;
        el.src = url;
        await el.play();
        setSource("platform");
        // 喇叭的「正在播」一直亮到这句放完（或者被下一句打断）。
        await new Promise<void>((resolve) => {
          el.onended = el.onpause = el.onerror = () => resolve();
        });
      } catch {
        try {
          setSource(await speakInBrowser(text));
        } catch {
          setSource(null);
        }
      } finally {
        setSpeaking(null);
      }
    },
    [resolveUrl],
  );

  return { play, prefetch, speaking, source };
}
