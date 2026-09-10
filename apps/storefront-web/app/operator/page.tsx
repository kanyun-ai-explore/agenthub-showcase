"use client";

/**
 * Minimal operator page for contract b (reproduction plan §6, M3): list changes
 * the merchant stdio server has staged and mirrored here, approve or discard them.
 * Approving here is what actually lets `apply_change` succeed in the agent session
 * — see `lib/backend/changes-store.ts` for the full contract and its documented
 * approve/discard asymmetry.
 */

import { useCallback, useEffect, useState } from "react";
import type { PendingChange } from "@/lib/backend/types-merchant";
import { SHOWCASE_MERCHANT_ID } from "@/lib/showcase/merchant";

// One id for the whole demo. It used to be hardcoded to MockRetailMerchant's own
// default ("acme-retail") while the session route injected "acme-outdoors", which
// silently produced an empty queue: the agent staged and mirrored fine, under a key
// this page never asked for.
const MERCHANT_ID = SHOWCASE_MERCHANT_ID;

export default function OperatorPage() {
  const [changes, setChanges] = useState<PendingChange[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busyKey, setBusyKey] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const res = await fetch(`/api/changes/pending?merchantId=${MERCHANT_ID}`);
      if (!res.ok) throw new Error(`GET /api/changes/pending -> ${res.status}`);
      const data = (await res.json()) as { changes: PendingChange[] };
      setChanges(data.changes);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  useEffect(() => {
    refresh();
    const interval = setInterval(refresh, 4000);
    return () => clearInterval(interval);
  }, [refresh]);

  // Addressed by `mirror_key` (the store's own de-duplication key), NOT the bare
  // `change_id` — see lib/backend/changes-store.ts's module docstring for the real
  // collision this avoids (two different changes, staged by different ChangeLedger
  // lifetimes, can share the same sequential change_id).
  const act = async (mirrorKey: string, action: "approve" | "discard") => {
    setBusyKey(mirrorKey);
    try {
      const res = await fetch(`/api/changes/${encodeURIComponent(mirrorKey)}/${action}`, {
        method: "POST",
      });
      if (!res.ok) throw new Error(`POST .../${action} -> ${res.status}`);
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusyKey(null);
    }
  };

  return (
    <main style={{ maxWidth: 820, margin: "0 auto", padding: "32px 20px" }}>
      <h1 style={{ fontSize: 22, marginBottom: 4 }}>Merchant approvals</h1>
      <p style={{ color: "#9aa0a6", marginTop: 0, marginBottom: 24 }}>
        Pending changes staged by the merchant assistant. Approving here is what lets{" "}
        <code>apply_change</code> succeed in the conversation — approving in chat does not
        count (CMA&apos;s own <code>require_host_approval</code> semantics).
      </p>

      {error && (
        <p style={{ color: "#f28b82", background: "#3a1f1d", padding: 10, borderRadius: 6 }}>{error}</p>
      )}

      {changes === null ? (
        <p>Loading…</p>
      ) : changes.length === 0 ? (
        <p style={{ color: "#9aa0a6" }}>Nothing pending.</p>
      ) : (
        <ul style={{ listStyle: "none", padding: 0, display: "flex", flexDirection: "column", gap: 12 }}>
          {changes.map((change) => (
            <li
              key={change.mirror_key}
              style={{
                border: "1px solid #2a2e33",
                borderRadius: 8,
                padding: 16,
                background: change.approved ? "#132a1c" : "#14161a",
              }}
            >
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
                <strong>{change.kind}</strong>
                <span style={{ fontSize: 12, color: "#9aa0a6" }}>{change.change_id}</span>
              </div>
              <p style={{ margin: "8px 0" }}>{change.summary}</p>
              {change.guardrail_notes && change.guardrail_notes.length > 0 && (
                <ul style={{ margin: "4px 0", paddingLeft: 18, color: "#f9c67a", fontSize: 13 }}>
                  {change.guardrail_notes.map((note, i) => (
                    <li key={i}>{note}</li>
                  ))}
                </ul>
              )}
              <div style={{ display: "flex", gap: 8, marginTop: 10 }}>
                <button
                  disabled={busyKey === change.mirror_key || change.approved}
                  onClick={() => act(change.mirror_key, "approve")}
                  style={{
                    padding: "6px 14px",
                    borderRadius: 6,
                    border: "none",
                    background: change.approved ? "#2e7d32" : "#3d7bfd",
                    color: "white",
                    cursor: change.approved ? "default" : "pointer",
                  }}
                >
                  {change.approved ? "Approved" : "Approve"}
                </button>
                <button
                  disabled={busyKey === change.mirror_key}
                  onClick={() => act(change.mirror_key, "discard")}
                  style={{
                    padding: "6px 14px",
                    borderRadius: 6,
                    border: "1px solid #4a4f57",
                    background: "transparent",
                    color: "#e6e6e6",
                    cursor: "pointer",
                  }}
                >
                  Discard
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}
    </main>
  );
}
