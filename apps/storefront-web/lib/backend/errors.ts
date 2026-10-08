/**
 * Wire-level counterparts of `shopping_agent.backend.NotOffered`/`Unavailable`
 * (reproduction plan §6 contract a). A route throws one of these; `respondError`
 * turns it into the status code `http_backend.py`'s `_post` branches on — see that
 * module's docstring for the wire contract table.
 */

export class NotOfferedError extends Error {}
export class UnavailableError extends Error {}

/**
 * SDK 的**客户端侧**错误的 `status` 是 0（超时：`SESSION_TURN_WAIT_TIMEOUT` /
 * `SESSION_TURN_AUDIO_WAIT_TIMEOUT`，以及响应畸形那类），直接塞进 `Response.json`
 * 会抛 `RangeError: init["status"] must be in the range of 200 to 599` —— 表现成
 * 裸 500，页面里配好的超时文案与重试按钮永远到不了。用它把状态码收窄到合法区间：
 * 认识的就用，不认识的当上游故障（502）。**分流看 `code`，不看这个数。**
 */
export function httpStatusOf(err: { status?: number }): number {
  const status = err.status;
  return typeof status === "number" && status >= 400 && status <= 599 ? status : 502;
}

export function errorResponse(err: unknown): Response {
  if (err instanceof UnavailableError) {
    return Response.json({ error: "unavailable", detail: err.message }, { status: 409 });
  }
  if (err instanceof NotOfferedError) {
    return Response.json({ error: "not_offered", detail: err.message }, { status: 422 });
  }
  // eslint-disable-next-line no-console
  console.error("backend route error", err);
  return Response.json(
    { error: "internal", detail: err instanceof Error ? err.message : String(err) },
    { status: 500 },
  );
}
