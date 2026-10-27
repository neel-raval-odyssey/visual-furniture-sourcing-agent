"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { Icon } from "./primitives";

/**
 * "Run using saved evidence": one POST to the local offline-run route. The
 * pending state lasts exactly as long as the request (the orchestrator runs
 * inside it); there is no simulated progress.
 */
export function RunOfflineButton({ caseId }: { caseId: string }) {
  const router = useRouter();
  const [state, setState] = useState<{ kind: "idle" } | { kind: "running" } | { kind: "error"; message: string }>({ kind: "idle" });

  async function start() {
    setState({ kind: "running" });
    try {
      const res = await fetch("/api/sourcing/runs", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ caseId, mode: "offline-saved-evidence" }),
      });
      const body = (await res.json()) as { runId?: string; message?: string };
      if (!res.ok || !body.runId) {
        setState({ kind: "error", message: body.message ?? `The run could not be started (${res.status}).` });
        return;
      }
      router.push(`/sourcing/references/${caseId}/runs/${body.runId}`);
    } catch {
      setState({ kind: "error", message: "The local server could not be reached." });
    }
  }

  return (
    <div className="space-y-2">
      <button
        type="button"
        onClick={start}
        disabled={state.kind === "running"}
        className="inline-flex min-h-11 items-center gap-2 rounded-full bg-ink px-5 py-2.5 text-sm font-medium text-paper transition-colors hover:bg-ink-soft disabled:cursor-wait disabled:opacity-70"
      >
        <Icon name="play" className="h-4 w-4" />
        {state.kind === "running" ? "Running with saved evidence…" : "Run using saved evidence"}
      </button>
      <p className="text-xs text-muted">Offline: reuses saved candidates, images, SigLIP shortlist and Sol assessments. No marketplace search and no paid model request.</p>
      <p aria-live="polite" className="text-sm">
        {state.kind === "running" ? <span className="text-ink-soft">The run is in progress on this computer; this page will open its result when it finishes.</span> : null}
        {state.kind === "error" ? <span className="text-bad">{state.message}</span> : null}
      </p>
    </div>
  );
}
