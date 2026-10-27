"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";

export const POLL_INTERVAL_MS = 2000;
export const MAX_POLLS = 90;

/**
 * Bounded polling for a run whose journal says "running": reads the local
 * status route every 2 s, at most 90 times, and refreshes the page once the
 * run reaches a terminal state. Never mounted for finished runs.
 */
export function RunRefresher({ caseId, runId }: { caseId: string; runId: string }) {
  const router = useRouter();
  const [message, setMessage] = useState("This run is in progress. The page updates automatically when its journal changes.");

  useEffect(() => {
    let polls = 0;
    let stopped = false;
    const timer = setInterval(async () => {
      if (stopped) return;
      polls++;
      try {
        const res = await fetch(`/api/sourcing/runs/${caseId}/${runId}`, { cache: "no-store" });
        const body = (await res.json()) as { status?: string };
        if (body.status && body.status !== "running") {
          stopped = true;
          clearInterval(timer);
          setMessage(`Run ${body.status}. Loading the result…`);
          router.refresh();
          return;
        }
      } catch {
        // keep polling within the bound
      }
      if (polls >= MAX_POLLS) {
        stopped = true;
        clearInterval(timer);
        setMessage("Stopped checking automatically. Reload the page to see the latest state.");
      }
    }, POLL_INTERVAL_MS);
    return () => {
      stopped = true;
      clearInterval(timer);
    };
  }, [caseId, runId, router]);

  return (
    <p aria-live="polite" className="text-sm text-info">
      {message}
    </p>
  );
}
