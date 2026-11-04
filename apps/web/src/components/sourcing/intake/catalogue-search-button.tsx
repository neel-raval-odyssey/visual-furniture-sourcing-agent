"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { Icon } from "../primitives";

/**
 * "Search saved catalogue": one POST that searches the saved product records
 * and compares the selected products locally. The pending state lasts exactly
 * as long as the request; there is no simulated progress. A repeated click
 * with unchanged records returns the earlier search and comparison.
 */
export function CatalogueSearchButton({ caseId, label = "Search saved catalogue" }: { caseId: string; label?: string }) {
  const router = useRouter();
  const [state, setState] = useState<{ kind: "idle" | "running" } | { kind: "error"; message: string }>({ kind: "idle" });
  return (
    <div className="space-y-2">
      <button
        type="button"
        disabled={state.kind === "running"}
        className="inline-flex min-h-12 items-center justify-center gap-2 rounded-full bg-ink px-6 text-base font-medium text-paper hover:bg-ink-soft disabled:cursor-wait disabled:opacity-60"
        onClick={async () => {
          setState({ kind: "running" });
          try {
            const res = await fetch(`/api/sourcing/catalogue/${caseId}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "search" }) });
            const body = (await res.json().catch(() => ({}))) as { runId?: string | null; message?: string };
            if (!res.ok) return setState({ kind: "error", message: body.message ?? `The search could not be completed (${res.status}).` });
            if (body.runId) {
              router.push(`/sourcing/results/${caseId}/${body.runId}`);
              return;
            }
            setState({ kind: "idle" });
            router.refresh();
          } catch {
            setState({ kind: "error", message: "The local server could not be reached." });
          }
        }}
      >
        <Icon name="forward" className="h-5 w-5" />
        {state.kind === "running" ? "Searching and comparing on this computer…" : label}
      </button>
      <p aria-live="polite" className="text-sm">
        {state.kind === "running" ? <span className="text-ink-soft">Searching the saved catalogue, then comparing photos on this computer. This can take a minute; the results open when it finishes.</span> : null}
        {state.kind === "error" ? <span className="text-bad">{state.message}</span> : null}
      </p>
    </div>
  );
}
