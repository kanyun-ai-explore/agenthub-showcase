"use client";

import { useEffect, useRef, useState } from "react";

/** Matches `lib/backend/ui-events.ts`'s `UiEvent` shape — re-declared (not
 * type-imported) so this client-bundled file never pulls in that server-only
 * module (an in-memory `Map`, Node-only) into the browser bundle. */
export interface UiEvent {
  seq: number;
  component: string;
  payload: unknown;
  postedAt: string;
}

/**
 * Subscribes to `/api/agent/ui-events`'s SSE stream for one `sessionId` — the
 * browser side of D-R4 mode B (reproduction plan §6 contract d). Independent of
 * whether an AgentHub session exists: the stdio server posts here whenever
 * `CMA_UI_DELIVERY=backend_post`, so this hook renders cards the same way whether
 * they came from a live agent turn or from an offline test driving the stdio
 * server directly (see runtime/tests/smoke_http_backend.py) — that overlap is
 * what makes this chain verifiable without a published agent.
 */
export function useUiEvents(sessionId: string | null): UiEvent[] {
  const [events, setEvents] = useState<UiEvent[]>([]);
  const sinceRef = useRef(0);

  useEffect(() => {
    if (!sessionId) return;
    setEvents([]);
    sinceRef.current = 0;
    const source = new EventSource(
      `/api/agent/ui-events?sessionId=${encodeURIComponent(sessionId)}&stream=1`,
    );
    source.onmessage = (message) => {
      try {
        const event = JSON.parse(message.data) as UiEvent;
        if (event.seq <= sinceRef.current) return; // dedupe a reconnect replay
        sinceRef.current = event.seq;
        setEvents((prev) => [...prev, event]);
      } catch {
        // heartbeat/comment lines have no `data:` payload reaching onmessage
      }
    };
    return () => source.close();
  }, [sessionId]);

  return events;
}
