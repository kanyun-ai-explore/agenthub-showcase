/** Shared request helpers for `app/api/backend/**` routes. */

/** D-R3: the customer identity the stdio server's `HttpStorefrontBackend` injects
 * from its own env — never a tool argument, so it never travels through the model.
 * Defaults to `"demo-user"` to match the stdio server's own `CMA_END_USER_ID`
 * default, so a curl test against this route with no header behaves the same as an
 * unconfigured session would. */
export function userIdFrom(req: Request): string {
  return req.headers.get("x-cma-user") ?? "demo-user";
}
