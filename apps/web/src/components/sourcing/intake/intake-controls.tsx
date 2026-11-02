"use client";

import { useRouter } from "next/navigation";
import { useRef, useState } from "react";
import { Icon } from "../primitives";
import { ACCEPTED_TYPES, precheckFile } from "../upload-dropzone";

/** Client controls for operator-assisted product intake. Every action is one POST to the local intake route. */

async function post(caseId: string, fields: Record<string, string | Blob | null | undefined>) {
  const form = new FormData();
  for (const [k, v] of Object.entries(fields)) if (v !== null && v !== undefined) form.append(k, v);
  const res = await fetch(`/api/sourcing/intake/${caseId}`, { method: "POST", body: form });
  const body = (await res.json().catch(() => ({}))) as { message?: string; field?: string | null };
  return { ok: res.ok, message: body.message ?? (res.ok ? null : `Something went wrong (${res.status}).`), field: body.field ?? null };
}

const primary = "inline-flex min-h-12 items-center justify-center gap-2 rounded-full bg-ink px-6 text-base font-medium text-paper hover:bg-ink-soft disabled:cursor-not-allowed disabled:opacity-50";
const secondary = "inline-flex min-h-11 items-center justify-center gap-1.5 rounded-full border border-line-strong px-4 text-sm font-medium text-ink hover:border-ink disabled:opacity-50";

export function StartIntakeButton({ caseId }: { caseId: string }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return (
    <div className="space-y-2">
      <button
        type="button"
        disabled={busy}
        className={primary}
        onClick={async () => {
          setBusy(true);
          const r = await post(caseId, { action: "start" });
          setBusy(false);
          if (!r.ok) setError(r.message);
          router.refresh();
        }}
      >
        <Icon name="upload" className="h-5 w-5" /> Add product leads
      </button>
      {error ? <p role="alert" className="text-sm text-bad">{error}</p> : null}
    </div>
  );
}

export function CopyButton({ text, label }: { text: string; label: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      className="inline-flex min-h-9 shrink-0 items-center gap-1 rounded-full border border-line px-3 text-xs font-medium text-ink-soft hover:border-ink"
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(text);
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        } catch {
          setCopied(false);
        }
      }}
    >
      {copied ? "Copied" : "Copy"}
      <span className="sr-only">: {label}</span>
    </button>
  );
}

export interface EntryFormValues {
  entryId: string;
  listingUrl: string;
  title: string;
  supplierName: string;
  supplierProfileUrl: string;
  priceMin: string;
  priceMax: string;
  currency: string;
  priceUnit: string;
  moqQuantity: string;
  moqUnit: string;
  foundWith: string;
  queryUsed: string;
  notes: string;
  hasImage: boolean;
}

const FOUND_WITH_LABELS: [string, string][] = [
  ["alibaba_image_search", "Alibaba.com image search"],
  ["alibaba_keyword_search", "Alibaba.com keyword search"],
  ["alibaba_lens", "Alibaba Lens"],
  ["other", "Other page on Alibaba.com"],
];

function Field({ label, name, hint, error, defaultValue, type = "text", required = false, inputMode, autoComplete = "off" }: { label: string; name: string; hint?: string; error?: string | null; defaultValue?: string; type?: string; required?: boolean; inputMode?: "decimal" | "numeric" | "url"; autoComplete?: string }) {
  return (
    <label className="block space-y-1">
      <span className="text-sm font-medium text-ink">
        {label}
        {required ? null : <span className="font-normal text-muted"> (if shown)</span>}
      </span>
      <input
        name={name}
        type={type}
        defaultValue={defaultValue}
        required={required}
        inputMode={inputMode}
        autoComplete={autoComplete}
        aria-invalid={error ? true : undefined}
        className={`block min-h-11 w-full rounded-xl border bg-paper px-3 text-sm text-ink ${error ? "border-bad" : "border-line-strong"}`}
      />
      {hint ? <span className="block text-xs text-muted">{hint}</span> : null}
      {error ? <span className="block text-xs text-bad">{error}</span> : null}
    </label>
  );
}

/**
 * Records one product exactly as shown on its Alibaba.com page, with a photo
 * the operator saved. Empty optional fields stay empty: nothing is guessed.
 */
export function EntryForm({ caseId, intakeId, queries, initial, onDone }: { caseId: string; intakeId: string; queries: string[]; initial?: EntryFormValues; onDone?: () => void }) {
  const router = useRouter();
  const formRef = useRef<HTMLFormElement>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<{ message: string; field: string | null } | null>(null);
  const editing = Boolean(initial?.entryId);
  const fieldError = (f: string) => (error?.field === f ? error.message : null);

  async function submit(form: HTMLFormElement) {
    const data = new FormData(form);
    const file = data.get("file");
    if (file instanceof File && file.size > 0) {
      const problem = precheckFile(file);
      if (problem) return setError({ message: problem, field: "image" });
    }
    setBusy(true);
    setError(null);
    const fields: Record<string, string | Blob | null> = { action: "save", intakeId };
    data.forEach((v, k) => {
      if (!(v instanceof File && v.size === 0)) fields[k] = v;
    });
    const r = await post(caseId, fields);
    setBusy(false);
    if (!r.ok) return setError({ message: r.message ?? "Not saved.", field: r.field });
    if (!editing) form.reset();
    onDone?.();
    router.refresh();
  }

  return (
    <form
      ref={formRef}
      onSubmit={(e) => {
        e.preventDefault();
        void submit(e.currentTarget);
      }}
      className="space-y-4"
      noValidate
    >
      {initial?.entryId ? <input type="hidden" name="entryId" value={initial.entryId} /> : null}
      <Field label="Alibaba.com product link" name="listingUrl" type="url" inputMode="url" required defaultValue={initial?.listingUrl} hint="Copy it from the browser's address bar on the product page." error={fieldError("listingUrl")} />
      <Field label="Product title" name="title" required defaultValue={initial?.title} hint="As shown on the listing." error={fieldError("title")} />
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Supplier name" name="supplierName" defaultValue={initial?.supplierName} error={fieldError("supplierName")} />
        <Field label="Supplier page link" name="supplierProfileUrl" type="url" inputMode="url" defaultValue={initial?.supplierProfileUrl} error={fieldError("supplierProfileUrl")} />
      </div>
      <fieldset className="grid gap-4 sm:grid-cols-4">
        <legend className="mb-1 text-sm font-medium text-ink">
          Listed price <span className="font-normal text-muted">(if shown)</span>
        </legend>
        <Field label="Lowest" name="priceMin" inputMode="decimal" defaultValue={initial?.priceMin} error={fieldError("priceMin")} />
        <Field label="Highest" name="priceMax" inputMode="decimal" defaultValue={initial?.priceMax} error={fieldError("priceMax")} />
        <Field label="Currency" name="currency" defaultValue={initial?.currency} hint="e.g. USD" error={fieldError("currency")} />
        <Field label="Per" name="priceUnit" defaultValue={initial?.priceUnit} hint="e.g. piece" />
      </fieldset>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Minimum order" name="moqQuantity" inputMode="numeric" defaultValue={initial?.moqQuantity} error={fieldError("moqQuantity")} />
        <Field label="Order unit" name="moqUnit" defaultValue={initial?.moqUnit} hint="e.g. piece, set" />
      </div>
      <div className="grid gap-4 sm:grid-cols-2">
        <label className="block space-y-1">
          <span className="text-sm font-medium text-ink">How you found it</span>
          <select name="foundWith" defaultValue={initial?.foundWith ?? "alibaba_image_search"} className="block min-h-11 w-full rounded-xl border border-line-strong bg-paper px-3 text-sm">
            {FOUND_WITH_LABELS.map(([v, l]) => (
              <option key={v} value={v}>
                {l}
              </option>
            ))}
          </select>
        </label>
        <label className="block space-y-1">
          <span className="text-sm font-medium text-ink">
            Search used <span className="font-normal text-muted">(optional)</span>
          </span>
          <select name="queryUsed" defaultValue={initial?.queryUsed ?? ""} className="block min-h-11 w-full rounded-xl border border-line-strong bg-paper px-3 text-sm">
            <option value="">None / image search</option>
            {queries.map((q) => (
              <option key={q} value={q}>
                {q}
              </option>
            ))}
          </select>
        </label>
      </div>
      <label className="block space-y-1">
        <span className="text-sm font-medium text-ink">
          Product photo <span className="font-normal text-muted">{initial?.hasImage ? "(choose a file to replace the current one)" : "(needed to compare designs)"}</span>
        </span>
        <input name="file" type="file" accept={ACCEPTED_TYPES.join(",")} className="block w-full text-sm file:mr-3 file:min-h-10 file:rounded-full file:border file:border-line-strong file:bg-paper file:px-4 file:text-sm" />
        <span className="block text-xs text-muted">Save the main product photo from the listing page (PNG, JPEG or WebP, up to 10 MB). It stays on this computer.</span>
        {fieldError("image") ? <span className="block text-xs text-bad">{fieldError("image")}</span> : null}
      </label>
      {initial?.hasImage ? (
        <label className="flex items-center gap-2 text-sm text-ink-soft">
          <input type="checkbox" name="removeImage" value="1" /> Remove the current photo
        </label>
      ) : null}
      <label className="block space-y-1">
        <span className="text-sm font-medium text-ink">
          Notes <span className="font-normal text-muted">(optional)</span>
        </span>
        <textarea name="notes" defaultValue={initial?.notes} rows={2} className="block w-full rounded-xl border border-line-strong bg-paper px-3 py-2 text-sm" />
      </label>
      {error && !error.field ? <p role="alert" className="text-sm text-bad">{error.message}</p> : null}
      <p aria-live="polite" className="sr-only">
        {error?.message ?? ""}
      </p>
      <div className="flex flex-wrap gap-3">
        <button type="submit" disabled={busy} className={primary}>
          {busy ? "Saving…" : editing ? "Save changes" : "Add this product"}
        </button>
        {onDone ? (
          <button type="button" className={secondary} onClick={onDone}>
            Cancel
          </button>
        ) : null}
      </div>
    </form>
  );
}

/** Edit and remove controls for one recorded product. */
export function EntryActions({ caseId, intakeId, queries, values }: { caseId: string; intakeId: string; queries: string[]; values: EntryFormValues }) {
  const router = useRouter();
  const [editing, setEditing] = useState(false);
  const [confirmRemove, setConfirmRemove] = useState(false);
  if (editing) return <EntryForm caseId={caseId} intakeId={intakeId} queries={queries} initial={values} onDone={() => setEditing(false)} />;
  return (
    <div className="flex flex-wrap gap-2">
      <button type="button" className={secondary} onClick={() => setEditing(true)}>
        Edit
      </button>
      {confirmRemove ? (
        <>
          <button
            type="button"
            className={`${secondary} border-bad text-bad`}
            onClick={async () => {
              await post(caseId, { action: "remove", intakeId, entryId: values.entryId });
              router.refresh();
            }}
          >
            Remove this product
          </button>
          <button type="button" className={secondary} onClick={() => setConfirmRemove(false)}>
            Keep
          </button>
        </>
      ) : (
        <button type="button" className={secondary} onClick={() => setConfirmRemove(true)}>
          Remove
        </button>
      )}
    </div>
  );
}

export function CompleteButton({ caseId, intakeId, count, label, note }: { caseId: string; intakeId: string; count: number; label?: string; note?: string }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return (
    <div className="space-y-2">
      <button
        type="button"
        disabled={busy || count === 0}
        className={primary}
        onClick={async () => {
          setBusy(true);
          const r = await post(caseId, { action: "complete", intakeId });
          setBusy(false);
          if (!r.ok) setError(r.message);
          router.refresh();
        }}
      >
        <Icon name="check" className="h-5 w-5" /> {busy ? "Saving the product list…" : (label ?? `Finish: save ${count} product${count === 1 ? "" : "s"}`)}
      </button>
      <p className="text-xs text-muted">{note ?? "After this the list is saved as a version. You can add photos or corrections later as a new version."}</p>
      {error ? <p role="alert" className="text-sm text-bad">{error}</p> : null}
    </div>
  );
}

/** Opens a revision of the saved product list (pre-filled; the saved version is kept). */
export function StartRevisionButton({ caseId, label, quiet = false }: { caseId: string; label: string; quiet?: boolean }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return (
    <div className="space-y-2">
      <button
        type="button"
        disabled={busy}
        className={quiet ? secondary : primary}
        onClick={async () => {
          setBusy(true);
          const r = await post(caseId, { action: "revise" });
          setBusy(false);
          if (!r.ok) setError(r.message);
          router.refresh();
        }}
      >
        <Icon name="image" className={quiet ? "h-4 w-4" : "h-5 w-5"} /> {busy ? "Opening…" : label}
      </button>
      {error ? <p role="alert" className="text-sm text-bad">{error}</p> : null}
    </div>
  );
}

/** Attaches or replaces one product's photo; nothing else about the product changes. */
export function PhotoUpload({ caseId, intakeId, entryId, hasImage, title }: { caseId: string; intakeId: string; entryId: string; hasImage: boolean; title: string }) {
  const router = useRouter();
  const input = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function upload(file: File | undefined) {
    if (!file) return;
    const problem = precheckFile(file);
    if (problem) return setError(problem);
    setBusy(true);
    setError(null);
    const r = await post(caseId, { action: "photo", intakeId, entryId, file });
    setBusy(false);
    if (input.current) input.current.value = "";
    if (!r.ok) return setError(r.message);
    router.refresh();
  }
  return (
    <div className="space-y-1">
      <label className={`${hasImage ? secondary : primary} cursor-pointer`}>
        <Icon name="upload" className="h-4 w-4" /> {busy ? "Saving photo…" : hasImage ? "Replace photo" : "Add photo"}
        <span className="sr-only"> for {title}</span>
        <input ref={input} type="file" accept={ACCEPTED_TYPES.join(",")} className="sr-only" disabled={busy} onChange={(e) => void upload(e.target.files?.[0])} />
      </label>
      {error ? <p role="alert" className="text-sm text-bad">{error}</p> : null}
    </div>
  );
}

/** Closes the open revision without saving it. The saved product list is unchanged. */
export function DiscardButton({ caseId, intakeId }: { caseId: string; intakeId: string }) {
  const router = useRouter();
  const [confirming, setConfirming] = useState(false);
  if (!confirming) {
    return (
      <button type="button" className={secondary} onClick={() => setConfirming(true)}>
        Discard this revision
      </button>
    );
  }
  return (
    <div className="flex flex-wrap gap-2">
      <button
        type="button"
        className={`${secondary} border-bad text-bad`}
        onClick={async () => {
          await post(caseId, { action: "discard", intakeId });
          router.refresh();
        }}
      >
        Discard changes
      </button>
      <button type="button" className={secondary} onClick={() => setConfirming(false)}>
        Keep editing
      </button>
    </div>
  );
}
