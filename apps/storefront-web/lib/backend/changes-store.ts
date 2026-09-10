/**
 * Contract b (reproduction plan §6, M3): the operator-approval store for merchant
 * staged changes. This is NOT a `MerchantBackend` — CMA's own `ChangeLedger` (the
 * class that actually enforces guardrails and computes margin impact) lives inside
 * the merchant stdio server's own in-process `MockRetailMerchant` backend, one
 * instance per session process. This store is a separate, deliberately thin mirror
 * of that ledger's staged changes, kept only so a human operator has one page to
 * approve or discard from — the merchant stdio server POSTs here after every
 * stage/apply/discard call (`merchant-stdio-server/__main__.py`'s `_mirror_changes`),
 * and reads `approvedIds` back from here right before dispatching `apply_change`
 * (`_fetch_approved_ids`).
 *
 * Known, documented asymmetry (not a bug): **approve is authoritative, discard is
 * not.** Approving here is what `apply_change`'s gate actually checks — see
 * `merchant_agent.gates.check_apply_change`. Discarding here only hides the row
 * from this page (sets its local `status` to `"discarded"`); it cannot reach back
 * into a specific, possibly-not-running stdio server process's own `ChangeLedger`
 * the way a real single-process deployment's host action would. The conversational
 * `discard_change` tool is still what actually removes a change from the ledger
 * that is staging it; this page's discard is an operator-side "stop showing me
 * this" no different in effect from the operator simply not approving it.
 *
 * **Storage is keyed by `mirrorKeyOf(merchantId, change)`, NOT by the bare
 * `change_id` — a real bug found and fixed during M3's cross-process persistence
 * check.** CMA's own `ChangeLedger` generates ids as `f"chg-{sequence:04d}"`,
 * unique only within one `ChangeLedger` instance's lifetime. Now that the ledger
 * itself persists to disk (`merchant-stdio-server/__main__.py`'s
 * `_persist_ledger`/`_load_ledger_into`), the two persistence layers — the
 * ledger's own file, and this store — have DIFFERENT lifecycles: a sandbox
 * workspace reset (or simply a fresh, never-before-seen session) starts a new
 * `ChangeLedger` whose sequence restarts at `chg-0001`. Storing by bare
 * `change_id` meant a brand-new, never-approved change could inherit
 * `approved: true` from a completely unrelated, previously-applied change that
 * happened to reuse the same sequential id — confirmed by reproducing it
 * directly. `change.created_at` (a fresh `datetime.now(UTC)` every time
 * `ChangeLedger.stage()` runs, upstream code, unmodified) is the value that
 * actually differs across a ledger reset, so it anchors the storage key. The
 * WIRE contract to the Python side is unaffected either way: `change_id` stays a
 * plain field on every record and on `approved-ids`' response array — only this
 * store's OWN internal indexing changed, which is why `/api/changes/[id]/*`'s
 * `id` param is now this mirror key (URL-encoded), not the bare change_id — see
 * those routes and `app/operator/page.tsx`.
 */

import type { MirroredChange, PendingChange, StagedChange } from "./types-merchant";
import { CHANGES_FILE } from "./paths";
import { updateJsonFile, readJsonFile } from "./file-store";

type ChangesFile = Record<string, MirroredChange>;

const EMPTY: ChangesFile = {};

/** Not itself required to be unguessable/secret — it is a de-duplication key, not
 * an auth token; the approve/discard routes it addresses are only ever reached
 * from this app's own operator page. */
export function mirrorKeyOf(merchantId: string, change: Pick<StagedChange, "change_id" | "created_at">): string {
  return `${merchantId}|${change.change_id}|${change.created_at}`;
}

export async function mirrorChanges(merchantId: string, changes: StagedChange[]): Promise<void> {
  await updateJsonFile<ChangesFile, void>(CHANGES_FILE, EMPTY, (data) => {
    const next = { ...data };
    for (const change of changes) {
      const key = mirrorKeyOf(merchantId, change);
      const existing = next[key];
      next[key] = {
        ...change,
        merchant_id: merchantId,
        // Upsert preserves an existing approval only for a re-mirror of the SAME
        // change (identical merchant_id + change_id + created_at) — e.g. its
        // status moving staged -> applied must not silently un-approve it. A
        // different change that happens to reuse the same bare change_id (see the
        // module docstring) computes a different key here and starts unapproved.
        approved: existing?.approved ?? false,
      };
    }
    return { next, result: undefined };
  });
}

export async function pendingChanges(merchantId: string): Promise<PendingChange[]> {
  const data = await readJsonFile(CHANGES_FILE, EMPTY);
  return Object.entries(data)
    .filter(([, c]) => c.merchant_id === merchantId && c.status === "staged")
    .map(([mirror_key, c]) => ({ ...c, mirror_key }));
}

export async function approvedChangeIds(merchantId: string): Promise<string[]> {
  const pending = await pendingChanges(merchantId);
  // A bare change_id appearing more than once among currently-PENDING changes for
  // one merchant would require two live re-stages between a ledger reset and
  // either being applied/discarded — not reachable in this repo's flows, but
  // de-duplicated defensively since `state.approved_change_ids` is a set either way.
  return [...new Set(pending.filter((c) => c.approved).map((c) => c.change_id))];
}

export async function setApproved(mirrorKey: string, approved: boolean): Promise<MirroredChange | null> {
  return updateJsonFile<ChangesFile, MirroredChange | null>(CHANGES_FILE, EMPTY, (data) => {
    const existing = data[mirrorKey];
    if (!existing) return { next: data, result: null };
    const updated = { ...existing, approved };
    return { next: { ...data, [mirrorKey]: updated }, result: updated };
  });
}

/** The operator page's "discard" — see the module docstring's asymmetry note. */
export async function operatorDiscard(mirrorKey: string): Promise<MirroredChange | null> {
  return updateJsonFile<ChangesFile, MirroredChange | null>(CHANGES_FILE, EMPTY, (data) => {
    const existing = data[mirrorKey];
    if (!existing) return { next: data, result: null };
    const updated: MirroredChange = { ...existing, status: "discarded", approved: false };
    return { next: { ...data, [mirrorKey]: updated }, result: updated };
  });
}
