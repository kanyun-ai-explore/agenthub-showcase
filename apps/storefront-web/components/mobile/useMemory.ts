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
import { visitorPost } from "@/lib/showcase/visitor";

/**
 * subject 由服务端从访客 cookie `ahv` 取，body 里不带 `subject_id`。`visitorTag` 为 null 表示
 * 还没拿到 cookie，先不发。
 */

export interface MemoryApi {
  facts: MemoryFact[];
  busy: boolean;
  reload: () => void;
  clear: () => Promise<void>;
}

export function useMemory(visitorTag: string | null, refreshToken: number): MemoryApi {
  const [facts, setFacts] = useState<MemoryFact[]>([]);
  const [busy, setBusy] = useState(false);
  const [token, setToken] = useState(0);

  const load = useCallback(async () => {
    if (!visitorTag) return;
    const res = await visitorPost("/api/memory/get-facts", {});
    if (!res.ok) return;
    const data = (await res.json()) as { facts?: MemoryFact[] };
    setFacts(data.facts ?? []);
  }, [visitorTag]);

  useEffect(() => {
    void load();
  }, [load, token, refreshToken]);

  const clear = useCallback(async () => {
    if (!visitorTag) return;
    setBusy(true);
    try {
      // 服务端真清掉了才把面板清空：失败时面板照旧，免得显示「已清空」而记忆还在。
      const res = await visitorPost("/api/memory/clear", {});
      if (res.ok) setFacts([]);
    } finally {
      setBusy(false);
    }
  }, [visitorTag]);

  return { facts, busy, reload: () => setToken((v) => v + 1), clear };
}
