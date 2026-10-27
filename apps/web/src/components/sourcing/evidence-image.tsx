"use client";

import { useCallback, useRef, useState } from "react";
import { Icon } from "./primitives";

/**
 * A private evidence photograph served by the local evidence route. Shows a
 * real loading state and a plain-language error when the image is missing or
 * changed; can open full size in an accessible dialog for close inspection.
 */
export function EvidenceImage({
  src,
  alt,
  label,
  priority = false,
  zoomable = true,
  aspect = "aspect-[4/3]",
  fit = "contain",
}: {
  src: string | null;
  alt: string;
  label?: string;
  priority?: boolean;
  zoomable?: boolean;
  aspect?: string;
  fit?: "contain" | "cover";
}) {
  const [failed, setFailed] = useState(!src);
  const dialog = useRef<HTMLDialogElement>(null);
  // An image can fail before hydration attaches onError: check it when the element is attached.
  const imgRef = useCallback((el: HTMLImageElement | null) => {
    if (el?.complete && el.naturalWidth === 0) setFailed(true);
  }, []);

  return (
    <figure className="relative">
      <div className={`relative overflow-hidden rounded-xl border border-line bg-sand ${aspect}`}>
        {!failed ? <div className="absolute inset-0 animate-pulse bg-sand" aria-hidden /> : null}
        {src && !failed ? (
          // Private evidence comes from a local, no-store API route; Next image optimisation is not used for it.
          // eslint-disable-next-line @next/next/no-img-element
          <img
            ref={imgRef}
            src={src}
            alt={alt}
            loading={priority ? "eager" : "lazy"}
            decoding="async"
            onError={() => setFailed(true)}
            className={`relative h-full w-full ${fit === "cover" ? "object-cover" : "object-contain"}`}
          />
        ) : null}
        {failed ? (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 p-4 text-center text-sm text-muted" role="img" aria-label={`${alt} — image unavailable`}>
            <Icon name="image" className="h-6 w-6" />
            <span>{src ? "Image unavailable, or it changed since this run was recorded." : "No image available for comparison."}</span>
          </div>
        ) : null}
        {label ? (
          <span className="absolute left-3 top-3 rounded-full bg-paper/95 px-2.5 py-1 text-xs font-semibold tracking-wide text-ink shadow-sm">{label}</span>
        ) : null}
        {zoomable && src && !failed ? (
          <button
            type="button"
            onClick={() => dialog.current?.showModal()}
            className="absolute bottom-3 right-3 inline-flex min-h-10 items-center gap-1.5 rounded-full bg-paper/95 px-3 py-2 text-xs font-medium text-ink shadow-sm hover:bg-paper"
          >
            <Icon name="zoom" className="h-4 w-4" />
            View full size<span className="sr-only">: {alt}</span>
          </button>
        ) : null}
      </div>
      {zoomable && src ? (
        <dialog
          ref={dialog}
          aria-label={`${alt}, full size`}
          className="m-auto max-h-[95vh] max-w-[95vw] overflow-auto rounded-xl bg-paper p-0 shadow-2xl"
          onClick={(e) => {
            if (e.target === dialog.current) dialog.current?.close();
          }}
        >
          <div className="sticky top-0 flex items-center justify-between gap-4 border-b border-line bg-paper px-4 py-2">
            <p className="text-sm font-medium text-ink">{label ? `${label}: ` : ""}{alt}</p>
            <button type="button" onClick={() => dialog.current?.close()} className="inline-flex min-h-10 items-center gap-1 rounded-full px-3 text-sm text-ink hover:bg-sand" autoFocus>
              <Icon name="close" className="h-4 w-4" /> Close
            </button>
          </div>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={src} alt={alt} className="block h-auto max-w-none" />
        </dialog>
      ) : null}
    </figure>
  );
}
