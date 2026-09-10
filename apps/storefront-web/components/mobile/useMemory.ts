"use client";

/**
 * agent 记住的关于这个访客的事实。
 *
 * 读的是 `/api/memory/get-facts` —— 与 agent 的 `save_memory` / `recall_memories`
 * 同一个存储（stdio server 的 `HttpMemoryStore` 打的就是这几条路由），subject 就是
 * 访客 id。所以这个面板不是「展示我们支持记忆」的示意图，它显示的就是 agent
 * 真的写进去的那几条；清空之后 agent 下一轮也确实想不起来了。
 */

import { useCallback, useEffect, useState } from "react";
import type { MemoryFact } from "@/lib/backend/types";

export interface MemoryApi {
  facts: MemoryFact[];
  busy: boolean;
  reload: () => void;
  clear: () => Promise<void>;
}

export function useMemory(visitorId: string | null, refreshToken: number): MemoryApi {
  const [facts, setFacts] = useState<MemoryFact[]>([]);
  const [busy, setBusy] = useState(false);
  const [token, setToken] = useState(0);

  const load = useCallback(async () => {
    if (!visitorId) return;
    const res = await fetch("/api/memory/get-facts", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ subject_id: visitorId }),
    });
    if (!res.ok) return;
    const data = (await res.json()) as { facts?: MemoryFact[] };
    setFacts(data.facts ?? []);
  }, [visitorId]);

  useEffect(() => {
    void load();
  }, [load, token, refreshToken]);

  const clear = useCallback(async () => {
    if (!visitorId) return;
    setBusy(true);
    try {
      await fetch("/api/memory/clear", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ subject_id: visitorId }),
      });
      setFacts([]);
    } finally {
      setBusy(false);
    }
  }, [visitorId]);

  return { facts, busy, reload: () => setToken((v) => v + 1), clear };
}
