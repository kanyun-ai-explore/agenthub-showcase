/**
 * TypeScript mirror of `merchant_agent.types.StagedChange`, plus an `approved` flag
 * that model has no field for — approval is host-side bookkeeping (reproduction
 * plan §6 contract b), tracked here rather than on the change itself. See
 * `lib/backend/changes-store.ts` for why this store exists and what it can and
 * cannot promise.
 */

export interface ChangeItem {
  target: string;
  field: string;
  before?: unknown;
  after?: unknown;
}

export type ChangeKind = "listing_update" | "price_update" | "inventory_action" | "promotion" | "campaign";
export type ChangeStatus = "staged" | "applied" | "discarded";

export interface StagedChange {
  change_id: string;
  kind: ChangeKind;
  status: ChangeStatus;
  summary: string;
  items: ChangeItem[];
  created_at: string;
  created_by: string;
  created_by_kind?: "operator" | "agent";
  applied_at?: string | null;
  applied_by?: string | null;
  discarded_at?: string | null;
  discarded_by?: string | null;
  discarded_by_kind?: "operator" | "agent" | null;
  guardrail_notes?: string[];
  currency?: string | null;
  margin_impact?: number | null;
  margin_before_pct?: number | null;
  margin_after_pct?: number | null;
}

/** The record this store actually keeps: the mirrored change plus which merchant it
 * belongs to and whether an operator has approved it. */
export interface MirroredChange extends StagedChange {
  merchant_id: string;
  approved: boolean;
}

/** `MirroredChange` plus the store's own internal storage key (see
 * `changes-store.ts`'s `mirrorKeyOf` — NOT the bare `change_id`) — what
 * `pendingChanges()` returns to the operator page, which must address
 * approve/discard by this key, not by `change_id`. */
export interface PendingChange extends MirroredChange {
  mirror_key: string;
}
