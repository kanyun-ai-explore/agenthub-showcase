/**
 * The merchant identity the demo runs as.
 *
 * This must be ONE value: the agent stages changes under `CMA_MERCHANT_ID` (fixed in
 * `agenthub/agents/cma-merchant/agent.yaml` `env`, no longer injected per session so
 * the session can come from the prewarm pool), and the approval surface lists changes filtered
 * by the same id. When the two disagree the queue is simply empty — the agent
 * reports "staged", the mirror lands under a key nobody reads, and nothing anywhere
 * says why. That is exactly what happened while `app/operator/page.tsx` hardcoded
 * `acme-retail` and the session route passed `acme-outdoors`.
 */
export const SHOWCASE_MERCHANT_ID = "acme-outdoors";
export const SHOWCASE_OPERATOR = "demo-operator";
