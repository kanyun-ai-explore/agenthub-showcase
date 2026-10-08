"use client";

/**
 * 读音：站点自建 TTS（`/api/tts` → 模型网关 `/v1/audio/speech`），开一关时把这一关要念的
 * 句子全部预取成本地 blob，
 * 作答时点喇叭直接放，不再等合成。
 *
 * 站点 TTS 放不了（没配 key / 网关了 / 上游报错 / 限流 429）就退到浏览器自带的
 * speechSynthesis——听音题不至于是块死链接；题上会如实标出这次是「本机语音」。
 */

import { useCallback, useEffect, useRef, useState } from "react";

export type TtsSource = "server" | "browser";

/** 预取的并发：一关最多十来句，两条并发够快，也不至于一下子把站点的限流打满。 */
const PREFETCH_CONCURRENCY = 2;

function speakInBrowser(text: string): Promise<TtsSource> {
  return new Promise((resolve, reject) => {
    const synth = typeof window === "undefined" ? undefined : window.speechSynthesis;
    if (!synth) {
      reject(new Error("这个浏览器没有 speechSynthesis"));
      return;
    }
    const utterance = new SpeechSynthesisUtterance(text);
    utterance.lang = "en-US";
    // 默认语速对一年级偏快，慢一点听得清
    utterance.rate = 0.85;
    utterance.onend = () => resolve("browser");
    utterance.onerror = () => reject(new Error("本机语音播放失败"));
    synth.cancel();
    synth.speak(utterance);
  });
}

export function useSpeech() {
  /** 句子 → blob URL（成功取到的）；同一句只取一次。 */
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
  const fetchUrl = useCallback((text: string): Promise<string | null> => {
    const cached = urls.current.get(text);
    if (cached) return Promise.resolve(cached);
    const pending = inflight.current.get(text);
    if (pending) return pending;
    const request = (async () => {
      try {
        const res = await fetch(`/api/tts?text=${encodeURIComponent(text)}`);
        if (!res.ok) return null;
        const blob = await res.blob();
        if (blob.size === 0) return null;
        const url = URL.createObjectURL(blob);
        urls.current.set(text, url);
        return url;
      } catch {
        return null;
      } finally {
        inflight.current.delete(text);
      }
    })();
    inflight.current.set(text, request);
    return request;
  }, []);

  /** 把一关要念的句子都先取下来。取不到的不重试——点的时候再取一次，或者退本机语音。 */
  const prefetch = useCallback(
    async (texts: readonly string[]) => {
      const todo = [...new Set(texts.filter(Boolean))].filter((text) => !urls.current.has(text));
      let next = 0;
      const worker = async () => {
        while (next < todo.length) {
          const text = todo[next];
          next += 1;
          await fetchUrl(text);
        }
      };
      await Promise.all(Array.from({ length: Math.min(PREFETCH_CONCURRENCY, todo.length) }, worker));
    },
    [fetchUrl],
  );

  const play = useCallback(
    async (text: string): Promise<void> => {
      if (!text) return;
      setSpeaking(text);
      try {
        const url = await fetchUrl(text);
        if (!url) throw new Error("tts unavailable");
        const el = audio.current ?? new Audio();
        audio.current = el;
        el.src = url;
        await el.play();
        setSource("server");
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
    [fetchUrl],
  );

  return { play, prefetch, speaking, source };
}
