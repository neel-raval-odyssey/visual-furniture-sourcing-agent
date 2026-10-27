"use client";

import { useRouter } from "next/navigation";
import { useEffect } from "react";

/**
 * After a refresh during an analysis, polls the read-only status endpoint and
 * reloads the page once the recorded state changes. Never starts a request.
 */
export function AnalysisRefresher({ uploadId, intervalMs = 3000, maxPolls = 100 }: { uploadId: string; intervalMs?: number; maxPolls?: number }) {
  const router = useRouter();
  useEffect(() => {
    let polls = 0;
    let stopped = false;
    const timer = setInterval(async () => {
      if (stopped || ++polls > maxPolls) return clearInterval(timer);
      try {
        const res = await fetch(`/api/sourcing/uploads/${uploadId}/analysis`, { cache: "no-store" });
        const body = (await res.json()) as { state?: string };
        if (body.state && body.state !== "analyzing") {
          stopped = true;
          clearInterval(timer);
          router.refresh();
        }
      } catch {
        // Keep polling; the server may be restarting.
      }
    }, intervalMs);
    return () => {
      stopped = true;
      clearInterval(timer);
    };
  }, [uploadId, intervalMs, maxPolls, router]);
  return null;
}
