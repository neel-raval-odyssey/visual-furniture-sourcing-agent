import { formatDate, STAGE_LABELS, stateLabel } from "@/lib/sourcing/ui/labels";
import { Badge } from "./primitives";

/** The recorded stage states of a run, exactly as in its journal. No progress percentage is invented. */
export function StageTimeline({ stages }: { stages: { name: string; state: string; startedAt: string | null; finishedAt: string | null; message: string | null }[] }) {
  if (stages.length === 0) return <p className="text-sm text-muted">No stage record is available for this run.</p>;
  return (
    <ol className="relative space-y-0">
      {stages.map((s, i) => {
        const st = stateLabel(s.state);
        return (
          <li key={s.name} className="relative grid grid-cols-[2rem_1fr] gap-3 pb-5 last:pb-0">
            <div className="flex flex-col items-center">
              <span className="flex h-7 w-7 items-center justify-center rounded-full border border-line-strong bg-paper text-xs font-semibold text-ink-soft">{i + 1}</span>
              {i < stages.length - 1 ? <span className="mt-1 w-px flex-1 bg-line" aria-hidden /> : null}
            </div>
            <div className="min-w-0 pb-1">
              <div className="flex flex-wrap items-center gap-2">
                <h3 className="font-medium text-ink">{STAGE_LABELS[s.name] ?? s.name}</h3>
                <Badge tone={st.tone}>{st.label}</Badge>
              </div>
              {s.message ? <p className="mt-1 break-words text-sm text-ink-soft">{s.message}</p> : null}
              {s.finishedAt || s.startedAt ? (
                <p className="mt-0.5 text-xs text-muted">
                  {s.startedAt ? `Started ${formatDate(s.startedAt)}` : ""}
                  {s.finishedAt ? `${s.startedAt ? " · " : ""}Finished ${formatDate(s.finishedAt)}` : ""}
                </p>
              ) : null}
            </div>
          </li>
        );
      })}
    </ol>
  );
}
