"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import type { AssistView, BrowserCapture, OpenTab, TabOverview } from "@/lib/sourcing/browser-assist/session";
import { Icon, Notice } from "../primitives";
import { CopyButton, Field } from "./intake-controls";

/**
 * Supervised Alibaba.com search: the person searches in a separate Chrome
 * window; this panel lists the product pages they opened, captures the one
 * they choose, and adds it to the product list once they confirm the details.
 * Every button is one POST to the local browser route; nothing runs in the
 * background.
 */

const primary = "inline-flex min-h-12 items-center justify-center gap-2 rounded-full bg-ink px-6 text-base font-medium text-paper hover:bg-ink-soft disabled:cursor-not-allowed disabled:opacity-50";
const secondary = "inline-flex min-h-11 items-center justify-center gap-1.5 rounded-full border border-line-strong px-4 text-sm font-medium text-ink hover:border-ink disabled:opacity-50";

async function call(caseId: string, body: Record<string, unknown>) {
  try {
    const res = await fetch(`/api/sourcing/browser/${caseId}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    const json = (await res.json().catch(() => ({}))) as Record<string, unknown> & { message?: string; field?: string };
    return { ok: res.ok, body: json, message: res.ok ? null : (json.message ?? `Something went wrong (${res.status}).`), field: json.field ?? null };
  } catch {
    return { ok: false, body: {}, message: "The local server could not be reached.", field: null };
  }
}

export const BROWSER_EXPLANATION =
  "A separate Chrome window opens on Alibaba.com. You do the searching there: click the camera icon in Alibaba's search bar and upload your photo, sign in if Alibaba asks, and open the products you like. This app never clicks, types or scrolls on Alibaba.com, and keeps nothing until you confirm each product.";

export function BrowserAssistant({ caseId, view, photoPath }: { caseId: string; view: AssistView; photoPath: string | null }) {
  const router = useRouter();
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tabs, setTabs] = useState<TabOverview | null>(null);
  const [pending, setPending] = useState<BrowserCapture | null>(view.session?.pending ?? null);
  const session = view.session;

  if (!view.available) {
    return (
      <div className="space-y-2 rounded-2xl border border-line bg-paper p-5">
        <p className="font-medium text-ink">Search Alibaba.com with your photo</p>
        <p className="text-sm text-ink-soft">{view.unavailableReason}</p>
        <p className="text-sm text-muted">You can still search Alibaba.com in your own browser and add products by hand.</p>
      </div>
    );
  }
  if (view.busyElsewhere) {
    return (
      <Notice tone="neutral" title="The Alibaba.com window is open for another photo">
        Close it from that photo&apos;s page, then open it here.
      </Notice>
    );
  }

  const refreshTabs = async (sessionId: string) => {
    setBusy("tabs");
    setError(null);
    const r = await call(caseId, { action: "tabs", sessionId });
    setBusy(null);
    if (!r.ok) {
      setError(r.message);
      if (r.body.error === "not_open") router.refresh();
      return;
    }
    setTabs(r.body as unknown as TabOverview);
  };

  if (!session) {
    return (
      <div className="space-y-3 rounded-2xl border border-line bg-paper p-5">
        <p className="font-medium text-ink">Search Alibaba.com with your photo</p>
        <p className="text-sm text-ink-soft">{BROWSER_EXPLANATION}</p>
        <button
          type="button"
          className={primary}
          disabled={busy !== null}
          onClick={async () => {
            setBusy("start");
            setError(null);
            const r = await call(caseId, { action: "start" });
            setBusy(null);
            if (!r.ok) return setError(r.message);
            router.refresh();
          }}
        >
          <Icon name="forward" className="h-5 w-5" />
          {busy === "start" ? "Opening Chrome…" : "Open Alibaba.com in a separate window"}
        </button>
        <p aria-live="polite" className="text-sm text-bad">
          {error}
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-5 rounded-2xl border border-line bg-paper p-5">
      <div className="space-y-2">
        <p className="font-medium text-ink">Alibaba.com window open · {session.added} added in this session</p>
        <ol className="list-decimal space-y-1 pl-5 text-sm text-ink-soft">
          <li>In the Alibaba.com window, click the camera icon in the search bar and choose your photo.</li>
          <li>If Alibaba asks you to sign in or confirm you&apos;re a person, do that there. This app waits.</li>
          <li>Open each product you like in its own tab, then press “Check open product pages” here.</li>
          <li>Add one product at a time. Check the details against the page before confirming.</li>
        </ol>
        {photoPath ? (
          <div className="flex flex-wrap items-center gap-2 text-xs text-muted">
            <span className="min-w-0 break-all">Your photo: {photoPath}</span>
            <CopyButton text={photoPath} label="photo location" />
            <span>In the file picker, press ⌘⇧G and paste this location.</span>
          </div>
        ) : null}
      </div>

      {pending ? (
        <ReviewCapture
          caseId={caseId}
          sessionId={session.sessionId}
          capture={pending}
          onDone={async () => {
            setPending(null);
            router.refresh();
            await refreshTabs(session.sessionId);
          }}
        />
      ) : (
        <div className="space-y-3">
          <button type="button" className={secondary} disabled={busy !== null} onClick={() => refreshTabs(session.sessionId)}>
            {busy === "tabs" ? "Checking…" : "Check open product pages"}
          </button>
          {tabs?.needsPerson ? (
            <Notice tone="warn" title="Alibaba.com is asking you something">
              Sign in or complete Alibaba&apos;s check in the Alibaba.com window, then check again. This app never answers these for you.
            </Notice>
          ) : null}
          {tabs ? (
            tabs.products.length ? (
              <ul className="space-y-2">
                {tabs.products.map((t) => (
                  <TabRow
                    key={t.targetId}
                    tab={t}
                    disabled={busy !== null}
                    busy={busy === t.targetId}
                    onAdd={async () => {
                      setBusy(t.targetId);
                      setError(null);
                      const r = await call(caseId, { action: "capture", sessionId: session.sessionId, targetId: t.targetId });
                      setBusy(null);
                      if (!r.ok) return setError(r.message);
                      setPending(r.body.capture as BrowserCapture);
                    }}
                  />
                ))}
              </ul>
            ) : (
              <p className="text-sm text-muted">No Alibaba.com product page is open yet{tabs.otherTabs ? ` (${tabs.otherTabs} other ${tabs.otherTabs === 1 ? "tab" : "tabs"} ignored)` : ""}. Open a product from the search results, then check again.</p>
            )
          ) : null}
        </div>
      )}

      <p aria-live="polite" className="text-sm text-bad">
        {error}
      </p>
      <button
        type="button"
        className="text-sm text-muted underline underline-offset-2 hover:text-ink"
        disabled={busy !== null}
        onClick={async () => {
          setBusy("close");
          await call(caseId, { action: "close", sessionId: session.sessionId });
          setBusy(null);
          setTabs(null);
          setPending(null);
          router.refresh();
        }}
      >
        Close the Alibaba.com window
      </button>
    </div>
  );
}

function TabRow({ tab, onAdd, disabled, busy }: { tab: OpenTab; onAdd: () => void; disabled: boolean; busy: boolean }) {
  return (
    <li className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-line px-3 py-2">
      <div className="min-w-0 flex-1">
        <p className="break-words text-sm text-ink">{tab.title ?? "Untitled product page"}</p>
        <p className="text-xs text-muted">Alibaba.com product {tab.marketplaceProductId}</p>
      </div>
      {tab.added ? (
        <span className="text-xs font-medium text-good">In your list</span>
      ) : (
        <button type="button" className={secondary} disabled={disabled} onClick={onAdd}>
          {busy ? "Capturing…" : "Add this product"}
        </button>
      )}
    </li>
  );
}

function ReviewCapture({ caseId, sessionId, capture, onDone }: { caseId: string; sessionId: string; capture: BrowserCapture; onDone: () => Promise<void> }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<{ message: string; field: string | null } | null>(null);
  const fieldError = (name: string) => (error?.field === name ? error.message : null);
  return (
    <form
      className="space-y-4 rounded-xl border border-line-strong p-4"
      noValidate
      onSubmit={async (e) => {
        e.preventDefault();
        const data = new FormData(e.currentTarget);
        const text = (k: string) => {
          const v = data.get(k);
          return typeof v === "string" ? v : null;
        };
        setBusy(true);
        setError(null);
        const fields = Object.fromEntries(["title", "supplierName", "supplierProfileUrl", "priceMin", "priceMax", "currency", "priceUnit", "moqQuantity", "moqUnit", "foundWith", "notes"].map((k) => [k, text(k)]));
        const r = await call(caseId, { action: "confirm", sessionId, captureId: capture.captureId, keepPhoto: data.get("keepPhoto") === "on", fields });
        setBusy(false);
        if (!r.ok) return setError({ message: r.message ?? "Not saved.", field: r.field });
        await onDone();
      }}
    >
      <p className="font-medium text-ink">Check this product before adding it</p>
      <p className="break-all text-xs text-muted">{capture.listingUrl}</p>
      {capture.image ? (
        <div className="space-y-2">
          {/* eslint-disable-next-line @next/next/no-img-element -- local, hash-checked capture served by the browser route */}
          <img src={`/api/sourcing/browser/${caseId}?session=${sessionId}&capture=${capture.captureId}`} alt="Picture captured from the product page" className="max-h-72 rounded-lg border border-line object-contain" />
          <label className="flex items-center gap-2 text-sm text-ink">
            <input type="checkbox" name="keepPhoto" defaultChecked className="h-4 w-4" /> Keep this picture as the product photo
          </label>
        </div>
      ) : (
        <Notice tone="warn" title="No picture captured">
          {capture.imageProblem ?? "No picture was captured."} The product can still be added without a photo; it won&apos;t be compared until it has one.
        </Notice>
      )}
      <Field label="Product title" name="title" required defaultValue={capture.pageTitle ?? ""} hint="Suggested from the page's tab title. Check it matches the listing." error={fieldError("title")} />
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Supplier name" name="supplierName" hint="As shown on the listing" error={fieldError("supplierName")} />
        <Field label="Supplier page link" name="supplierProfileUrl" type="url" inputMode="url" error={fieldError("supplierProfileUrl")} />
      </div>
      <fieldset className="grid gap-4 sm:grid-cols-4">
        <legend className="mb-1 text-sm font-medium text-ink">
          Listed price <span className="font-normal text-muted">(if shown)</span>
        </legend>
        <Field label="Lowest" name="priceMin" inputMode="decimal" error={fieldError("priceMin")} />
        <Field label="Highest" name="priceMax" inputMode="decimal" error={fieldError("priceMax")} />
        <Field label="Currency" name="currency" hint="e.g. USD" error={fieldError("currency")} />
        <Field label="Per" name="priceUnit" hint="e.g. piece" />
      </fieldset>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Minimum order" name="moqQuantity" inputMode="numeric" error={fieldError("moqQuantity")} />
        <Field label="Order unit" name="moqUnit" hint="e.g. piece, set" />
      </div>
      <label className="block space-y-1">
        <span className="text-sm font-medium text-ink">How you found it</span>
        <select name="foundWith" defaultValue="alibaba_image_search" className="block min-h-11 w-full rounded-xl border border-line-strong bg-paper px-3 text-sm">
          <option value="alibaba_image_search">Alibaba.com image search</option>
          <option value="alibaba_keyword_search">Alibaba.com keyword search</option>
          <option value="other">Other page on Alibaba.com</option>
        </select>
      </label>
      <Field label="Notes" name="notes" hint="Optional" />
      {error && !error.field ? <p className="text-sm text-bad">{error.message}</p> : null}
      <div className="flex flex-wrap gap-3">
        <button type="submit" className={primary} disabled={busy}>
          {busy ? "Adding…" : "Add to my product list"}
        </button>
        <button
          type="button"
          className={secondary}
          disabled={busy}
          onClick={async () => {
            setBusy(true);
            const r = await call(caseId, { action: "discard", sessionId, captureId: capture.captureId });
            setBusy(false);
            if (!r.ok) return setError({ message: r.message ?? "Not discarded.", field: null });
            await onDone();
          }}
        >
          Discard
        </button>
      </div>
    </form>
  );
}
