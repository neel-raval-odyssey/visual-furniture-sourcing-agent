import type { ReactNode } from "react";
import type { Tone } from "@/lib/sourcing/ui/labels";

/** Small, dependency-free building blocks shared by the sourcing screens. */

const ICONS = {
  check: "M5 12.5l4.5 4.5L19 7.5",
  alert: "M12 8v5m0 3.5v.5M10.3 3.9L2.6 17.2A2 2 0 004.3 20h15.4a2 2 0 001.7-2.8L13.7 3.9a2 2 0 00-3.4 0z",
  lock: "M7 11V8a5 5 0 0110 0v3M5.5 11h13a1 1 0 011 1v7.5a1 1 0 01-1 1h-13a1 1 0 01-1-1V12a1 1 0 011-1z",
  clock: "M12 7v5l3 2m6-2a9 9 0 11-18 0 9 9 0 0118 0z",
  external: "M14 5h5v5m0-5l-8 8M10 5H6a1 1 0 00-1 1v12a1 1 0 001 1h12a1 1 0 001-1v-4",
  back: "M15 18l-6-6 6-6",
  forward: "M9 18l6-6-6-6",
  image: "M4 5h16v14H4zM4 15l4.5-4.5 4 4 3-3L20 15M15.5 8.5h.01",
  upload: "M12 16V4m0 0l-4.5 4.5M12 4l4.5 4.5M4 16v3a1 1 0 001 1h14a1 1 0 001-1v-3",
  info: "M12 11v6m0-9.5V7m9 5a9 9 0 11-18 0 9 9 0 0118 0z",
  minus: "M6 12h12",
  dot: "M12 12h.01",
  zoom: "M11 7v8m-4-4h8m6 10l-5-5m1.5-5a6.5 6.5 0 11-13 0 6.5 6.5 0 0113 0z",
  close: "M6 6l12 12M18 6L6 18",
  play: "M8 5.5v13l11-6.5-11-6.5z",
  partial: "M12 3a9 9 0 100 18V3z",
  x: "M8 8l8 8M16 8l-8 8",
} as const;

export type IconName = keyof typeof ICONS;

export function Icon({ name, className = "h-4 w-4", title }: { name: IconName; className?: string; title?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.7} strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden={title ? undefined : true} role={title ? "img" : undefined}>
      {title ? <title>{title}</title> : null}
      <path d={ICONS[name]} />
    </svg>
  );
}

const TONES: Record<Tone, string> = {
  ok: "bg-ok-soft text-ok border-ok/25",
  info: "bg-info-soft text-info border-info/25",
  warn: "bg-warn-soft text-warn border-warn/25",
  bad: "bg-bad-soft text-bad border-bad/25",
  neutral: "bg-sand text-muted border-line",
  accent: "bg-accent-soft text-accent border-accent/25",
};
const TONE_ICON: Record<Tone, IconName> = { ok: "check", info: "clock", warn: "alert", bad: "alert", neutral: "minus", accent: "dot" };

/** A status label that never relies on colour alone: it always carries an icon and text. */
export function Badge({ tone, children, icon }: { tone: Tone; children: ReactNode; icon?: IconName }) {
  return (
    <span className={`inline-flex items-center gap-1 rounded-full border px-2.5 py-0.5 text-xs font-medium whitespace-nowrap ${TONES[tone]}`}>
      <Icon name={icon ?? TONE_ICON[tone]} className="h-3.5 w-3.5" />
      {children}
    </span>
  );
}

export function Eyebrow({ children }: { children: ReactNode }) {
  return <p className="text-xs font-semibold uppercase tracking-[0.14em] text-muted">{children}</p>;
}

export function SectionTitle({ id, eyebrow, title, children }: { id?: string; eyebrow?: string; title: string; children?: ReactNode }) {
  return (
    <div className="mb-5 flex flex-wrap items-end justify-between gap-3">
      <div>
        {eyebrow ? <Eyebrow>{eyebrow}</Eyebrow> : null}
        <h2 id={id} className="mt-1 font-serif text-2xl text-ink sm:text-[1.7rem]">
          {title}
        </h2>
      </div>
      {children}
    </div>
  );
}

export function Notice({ tone = "info", title, children }: { tone?: Tone; title: string; children?: ReactNode }) {
  const icon: IconName = tone === "bad" || tone === "warn" ? "alert" : tone === "ok" ? "check" : tone === "neutral" ? "lock" : "info";
  return (
    <div className={`flex gap-3 rounded-xl border px-4 py-3 text-sm ${TONES[tone]}`} role={tone === "bad" ? "alert" : undefined}>
      <Icon name={icon} className="mt-0.5 h-4 w-4 shrink-0" />
      <div className="min-w-0">
        <p className="font-medium">{title}</p>
        {children ? <div className="mt-1 text-ink-soft">{children}</div> : null}
      </div>
    </div>
  );
}

export function ExternalLink({ href, children, className = "" }: { href: string; children: ReactNode; className?: string }) {
  return (
    <a href={href} target="_blank" rel="noopener noreferrer" className={`inline-flex items-center gap-1 font-medium text-accent underline-offset-4 hover:underline ${className}`}>
      {children}
      <Icon name="external" className="h-3.5 w-3.5" />
      <span className="sr-only">(opens the original marketplace page in a new tab)</span>
    </a>
  );
}

export function DataRow({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="grid grid-cols-[minmax(7rem,40%)_1fr] gap-3 border-b border-line py-2 text-sm last:border-b-0">
      <dt className="text-muted">{label}</dt>
      <dd className="min-w-0 break-words text-ink">{children}</dd>
    </div>
  );
}
