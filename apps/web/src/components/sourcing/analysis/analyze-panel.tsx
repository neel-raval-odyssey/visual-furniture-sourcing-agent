"use client";

import { useRouter } from "next/navigation";
import { useRef, useState } from "react";
import { Icon } from "../primitives";

export const MODEL_DOCS_URL = "https://developers.openai.com/api/docs/models/gpt-6-luna";

/** Shown while the one confirmed request is in progress (also rendered by the server after a refresh). */
export function AnalyzingNotice() {
  return (
    <div role="status" aria-live="polite" className="flex gap-3 rounded-2xl border border-info/25 bg-info-soft p-5">
      <span className="mt-1 h-4 w-4 shrink-0 animate-spin rounded-full border-2 border-info border-t-transparent motion-reduce:animate-none" aria-hidden />
      <div>
        <p className="font-medium text-ink">Analyzing furniture details</p>
        <p className="mt-1 text-sm text-ink-soft">Examining the visible shape, structure and distinctive design features. This usually takes under a minute. No product search is happening.</p>
      </div>
    </div>
  );
}

/**
 * "Analyze this photo": opens a confirmation dialog that explains the paid
 * request. Opening, closing or cancelling never contacts the server; only
 * "Confirm and analyze" sends one POST carrying the key of what was shown.
 */
export function AnalyzePanel({ uploadId, attemptKey, model }: { uploadId: string; attemptKey: string; model: string }) {
  const router = useRouter();
  const dialog = useRef<HTMLDialogElement>(null);
  const [phase, setPhase] = useState<"idle" | "sending" | "error">("idle");
  const [message, setMessage] = useState<string | null>(null);

  async function confirm() {
    if (phase === "sending") return;
    setPhase("sending");
    dialog.current?.close();
    try {
      const res = await fetch(`/api/sourcing/uploads/${uploadId}/analysis`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "analyze", attemptKey }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { message?: string };
        setPhase("error");
        setMessage(body.message ?? `The analysis didn't start (${res.status}).`);
      }
    } catch {
      // The request may still be running on the server; the page shows its recorded state.
      setPhase("error");
      setMessage("Lost contact with the local server. Refresh to see the recorded state of the analysis.");
    }
    router.refresh();
  }

  if (phase === "sending") return <AnalyzingNotice />;

  return (
    <div className="space-y-3">
      <button
        type="button"
        onClick={() => dialog.current?.showModal()}
        className="inline-flex min-h-12 items-center justify-center gap-2 rounded-full bg-ink px-6 text-base font-medium text-paper hover:bg-ink-soft"
      >
        <Icon name="zoom" className="h-5 w-5" /> Analyze this photo
      </button>
      {message ? (
        <p role="alert" className="text-sm text-bad">
          {message}
        </p>
      ) : null}
      <dialog ref={dialog} aria-labelledby="analyze-title" className="m-auto w-[min(36rem,calc(100vw-2rem))] rounded-2xl bg-paper p-0 text-ink shadow-2xl">
        <div className="space-y-4 p-6">
          <h2 id="analyze-title" className="font-serif text-2xl">
            Analyze this photo with AI?
          </h2>
          <ul className="space-y-2 text-sm text-ink-soft">
            <li className="flex gap-2">
              <Icon name="upload" className="mt-0.5 h-4 w-4 shrink-0 text-accent" />
              <span>
                This one photo will be sent to <strong className="font-medium text-ink">OpenAI</strong> and analyzed by <strong className="font-medium text-ink">GPT-6 Luna</strong> (<code className="text-xs">{model}</code>) for its shape, structure, materials, colours and distinctive details.
              </span>
            </li>
            <li className="flex gap-2">
              <Icon name="alert" className="mt-0.5 h-4 w-4 shrink-0 text-warn" />
              <span>
                This is a <strong className="font-medium text-ink">paid API request</strong> billed to the OpenAI account configured on this computer. The cost depends on the image size and the length of the answer, so it isn&apos;t known in advance. See{" "}
                <a href={MODEL_DOCS_URL} target="_blank" rel="noopener noreferrer" className="text-accent underline-offset-4 hover:underline">
                  current GPT-6 Luna pricing
                </a>
                .
              </span>
            </li>
            <li className="flex gap-2">
              <Icon name="lock" className="mt-0.5 h-4 w-4 shrink-0 text-muted" />
              <span>The result is saved privately on this computer as a furniture reference.</span>
            </li>
            <li className="flex gap-2">
              <Icon name="minus" className="mt-0.5 h-4 w-4 shrink-0 text-muted" />
              <span>It won&apos;t search Alibaba or anywhere else, and no product matches are created yet.</span>
            </li>
          </ul>
          <div className="flex flex-col-reverse gap-3 border-t border-line pt-4 sm:flex-row sm:justify-end">
            <button type="button" onClick={() => dialog.current?.close()} className="inline-flex min-h-11 items-center justify-center rounded-full border border-line-strong px-5 text-sm font-medium hover:border-ink" autoFocus>
              Cancel
            </button>
            <button type="button" onClick={confirm} className="inline-flex min-h-11 items-center justify-center rounded-full bg-ink px-5 text-sm font-medium text-paper hover:bg-ink-soft">
              Confirm and analyze
            </button>
          </div>
        </div>
      </dialog>
    </div>
  );
}

/** Finishes saving an already-paid result. Sends no request to OpenAI. */
export function FinishSavingButton({ uploadId }: { uploadId: string }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  return (
    <button
      type="button"
      disabled={busy}
      onClick={async () => {
        setBusy(true);
        await fetch(`/api/sourcing/uploads/${uploadId}/analysis`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "finish-saving" }) }).catch(() => null);
        setBusy(false);
        router.refresh();
      }}
      className="inline-flex min-h-11 items-center rounded-full border border-line-strong px-5 text-sm font-medium hover:border-ink disabled:opacity-50"
    >
      {busy ? "Saving…" : "Finish saving (no new request)"}
    </button>
  );
}
