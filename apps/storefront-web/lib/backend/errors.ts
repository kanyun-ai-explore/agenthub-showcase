/**
 * Wire-level counterparts of `shopping_agent.backend.NotOffered`/`Unavailable`
 * (reproduction plan §6 contract a). A route throws one of these; `respondError`
 * turns it into the status code `http_backend.py`'s `_post` branches on — see that
 * module's docstring for the wire contract table.
 */

export class NotOfferedError extends Error {}
export class UnavailableError extends Error {}

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
