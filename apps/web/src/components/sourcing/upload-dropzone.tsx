"use client";

import { useRouter } from "next/navigation";
import { useEffect, useId, useRef, useState } from "react";
import { Icon } from "./primitives";

export const ACCEPTED_TYPES = ["image/png", "image/jpeg", "image/webp"] as const;
export const MAX_UPLOAD_MB = 10;

/** Client-side pre-check (the server validates the actual bytes again). Returns an error message or null. */
export function precheckFile(file: { name: string; type: string; size: number }): string | null {
  if (file.size === 0) return "That file is empty.";
  if (file.size > MAX_UPLOAD_MB * 1024 * 1024) return `That file is larger than ${MAX_UPLOAD_MB} MB.`;
  if (!(ACCEPTED_TYPES as readonly string[]).includes(file.type)) return "Please choose a PNG, JPEG or WebP photograph.";
  return null;
}

/**
 * Stages a new reference photo locally. Nothing is analysed or searched: the
 * upload page states that the photo awaits image understanding.
 */
export function UploadDropzone() {
  const router = useRouter();
  const inputId = useId();
  const input = useRef<HTMLInputElement>(null);
  const [file, setFile] = useState<File | null>(null);
  const [preview, setPreview] = useState<string | null>(null);
  const [drag, setDrag] = useState(false);
  const [status, setStatus] = useState<{ kind: "idle" | "uploading" } | { kind: "error"; message: string }>({ kind: "idle" });

  const previewRef = useRef<string | null>(null);
  const setPreviewUrl = (url: string | null) => {
    if (previewRef.current) URL.revokeObjectURL(previewRef.current);
    previewRef.current = url;
    setPreview(url);
  };
  // Release the object URL when the component goes away.
  useEffect(() => () => {
    if (previewRef.current) URL.revokeObjectURL(previewRef.current);
  }, []);

  function choose(f: File | undefined) {
    if (!f) return;
    const problem = precheckFile(f);
    if (problem) {
      setFile(null);
      setPreviewUrl(null);
      setStatus({ kind: "error", message: problem });
      return;
    }
    setStatus({ kind: "idle" });
    setFile(f);
    setPreviewUrl(URL.createObjectURL(f));
  }

  async function upload() {
    if (!file) return;
    setStatus({ kind: "uploading" });
    const form = new FormData();
    form.append("file", file);
    try {
      const res = await fetch("/api/sourcing/uploads", { method: "POST", body: form });
      const body = (await res.json()) as { id?: string; message?: string };
      if (!res.ok || !body.id) {
        setStatus({ kind: "error", message: body.message ?? `The photo was not accepted (${res.status}).` });
        return;
      }
      router.push(`/sourcing/uploads/${body.id}`);
    } catch {
      setStatus({ kind: "error", message: "The local server could not be reached." });
    }
  }

  return (
    <div className="space-y-3">
      <label
        htmlFor={inputId}
        onDragOver={(e) => {
          e.preventDefault();
          setDrag(true);
        }}
        onDragLeave={() => setDrag(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDrag(false);
          choose(e.dataTransfer.files[0]);
        }}
        className={`flex min-h-44 cursor-pointer flex-col items-center justify-center gap-2 rounded-2xl border-2 border-dashed px-6 py-8 text-center transition-colors ${
          drag ? "border-accent bg-accent-soft" : "border-line-strong bg-paper hover:border-accent"
        }`}
      >
        {preview ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={preview} alt="Selected photograph preview" className="max-h-48 rounded-lg object-contain" />
        ) : (
          <Icon name="upload" className="h-7 w-7 text-accent" />
        )}
        <span className="font-medium text-ink">{file ? file.name : "Drop a furniture photograph here, or choose a file"}</span>
        <span className="text-xs text-muted">PNG, JPEG or WebP · up to {MAX_UPLOAD_MB} MB · stored privately on this computer</span>
        <input
          ref={input}
          id={inputId}
          type="file"
          accept={ACCEPTED_TYPES.join(",")}
          className="sr-only"
          onChange={(e) => choose(e.target.files?.[0])}
        />
      </label>
      <div className="flex flex-wrap items-center gap-3">
        <button
          type="button"
          onClick={upload}
          disabled={!file || status.kind === "uploading"}
          className="inline-flex min-h-11 items-center gap-2 rounded-full bg-ink px-5 py-2.5 text-sm font-medium text-paper hover:bg-ink-soft disabled:cursor-not-allowed disabled:opacity-50"
        >
          <Icon name="upload" className="h-4 w-4" />
          {status.kind === "uploading" ? "Saving privately…" : "Stage photo"}
        </button>
        {file ? (
          <button type="button" onClick={() => { setFile(null); setPreviewUrl(null); if (input.current) input.current.value = ""; }} className="min-h-11 px-2 text-sm text-muted underline-offset-4 hover:underline">
            Clear
          </button>
        ) : null}
      </div>
      <p aria-live="polite" className="text-sm">
        {status.kind === "error" ? <span className="text-bad">{status.message}</span> : null}
      </p>
    </div>
  );
}
