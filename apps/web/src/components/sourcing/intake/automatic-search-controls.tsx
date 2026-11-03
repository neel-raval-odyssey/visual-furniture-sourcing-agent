"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { Icon } from "../primitives";

const primary = "inline-flex min-h-12 items-center justify-center gap-2 rounded-full bg-ink px-6 text-base font-medium text-paper hover:bg-ink-soft disabled:cursor-wait disabled:opacity-60";
const secondary = "inline-flex min-h-11 items-center justify-center gap-1.5 rounded-full border border-line-strong px-4 text-sm font-medium text-ink hover:border-ink disabled:opacity-50";

async function post(caseId: string, body: Record<string, unknown>) {
  try {
    const res = await fetch(`/api/sourcing/discovery/${caseId}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    const json = (await res.json().catch(() => ({}))) as { message?: string; discoveryId?: string };
    return { ok: res.ok, message: json.message ?? (res.ok ? null : `Something went wrong (${res.status}).`) };
  } catch {
    return { ok: false, message: "The local server could not be reached." };
  }
}

/**
 * Sends the confirmed search once. The request key was created when the
 * confirmation page was rendered, so a double click or a repeated submission
 * returns the same search instead of sending another.
 */
export function ConfirmSearchButton({ caseId, requestKey }: { caseId: string; requestKey: string }) {
  const router = useRouter();
  const [state, setState] = useState<{ kind: "idle" | "running" } | { kind: "error"; message: string }>({ kind: "idle" });
  return (
    <div className="space-y-2">
      <button
        type="button"
        className={primary}
        disabled={state.kind === "running"}
        onClick={async () => {
          setState({ kind: "running" });
          const r = await post(caseId, { action: "start", requestKey, confirmed: true });
          if (!r.ok) return setState({ kind: "error", message: r.message ?? "The search could not be started." });
          router.push(`/sourcing/find/${caseId}`);
          router.refresh();
        }}
      >
        <Icon name="forward" className="h-5 w-5" />
        {state.kind === "running" ? "Searching Alibaba.com product pages…" : "Confirm and search"}
      </button>
      <p aria-live="polite" className="text-sm">
        {state.kind === "running" ? <span className="text-ink-soft">The search is running on the server; this page will show the results when it finishes.</span> : null}
        {state.kind === "error" ? <span className="text-bad">{state.message}</span> : null}
      </p>
    </div>
  );
}

/** Caches the found listings' photos (only when photo retrieval is approved). Never repeats the search. */
export function FetchPhotosButton({ caseId, discoveryId }: { caseId: string; discoveryId: string }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return (
    <div className="space-y-2">
      <button
        type="button"
        className={secondary}
        disabled={busy}
        onClick={async () => {
          setBusy(true);
          const r = await post(caseId, { action: "images", discoveryId });
          setBusy(false);
          if (!r.ok) setError(r.message);
          router.refresh();
        }}
      >
        <Icon name="image" className="h-4 w-4" /> {busy ? "Preparing product photos…" : "Prepare product photos"}
      </button>
      {error ? <p role="alert" className="text-sm text-bad">{error}</p> : null}
    </div>
  );
}
