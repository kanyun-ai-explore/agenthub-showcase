/**
 * The `agent/ui-events` queue (reproduction plan §6 contract d, `CMA_UI_DELIVERY=
 * backend_post` mode): the stdio server POSTs `{component, payload}` here keyed by
 * `X-CMA-Chat-Session-Id`; the frontend reads them back either by polling (`GET
 * ?sessionId=&since=`) or by opening an SSE stream (`GET ?sessionId=&stream=1`).
 *
 * In-memory only, deliberately: this queue is a live hand-off between one turn's
 * tool call and a browser tab that may or may not be open right now, not a
 * durability requirement — a card the customer never saw because no tab was
 * listening is not a business record to recover after a restart the way an order
 * or a cart line is. Bounded per-session ring buffer (last 50) so a stdio server
 * a browser never connects to cannot leak memory over a long-running dev server.
 */

export interface UiEvent {
  seq: number;
  component: string;
  payload: unknown;
  postedAt: string;
}

interface SessionQueue {
  events: UiEvent[];
  nextSeq: number;
  listeners: Set<(event: UiEvent) => void>;
}

const MAX_EVENTS_PER_SESSION = 50;
const queues = new Map<string, SessionQueue>();

function queueFor(sessionId: string): SessionQueue {
  let queue = queues.get(sessionId);
  if (!queue) {
    queue = { events: [], nextSeq: 1, listeners: new Set() };
    queues.set(sessionId, queue);
  }
  return queue;
}

export function publishUiEvent(sessionId: string, component: string, payload: unknown): UiEvent {
  const queue = queueFor(sessionId);
  const event: UiEvent = { seq: queue.nextSeq++, component, payload, postedAt: new Date().toISOString() };
  queue.events.push(event);
  if (queue.events.length > MAX_EVENTS_PER_SESSION) queue.events.shift();
  for (const listener of queue.listeners) listener(event);
  return event;
}

export function eventsSince(sessionId: string, since: number): UiEvent[] {
  const queue = queues.get(sessionId);
  if (!queue) return [];
  return queue.events.filter((e) => e.seq > since);
}

/** Subscribes `listener` to every new event for `sessionId`; returns an unsubscribe
 * function. Used by the SSE route — see `app/api/agent/ui-events/route.ts`. */
export function subscribe(sessionId: string, listener: (event: UiEvent) => void): () => void {
  const queue = queueFor(sessionId);
  queue.listeners.add(listener);
  return () => queue.listeners.delete(listener);
}
