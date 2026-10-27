import type { Metadata } from "next";
import Link from "next/link";
import { EvidenceImage } from "@/components/sourcing/evidence-image";
import { Badge, Eyebrow, Icon, Notice, SectionTitle } from "@/components/sourcing/primitives";
import { UploadDropzone } from "@/components/sourcing/upload-dropzone";
import { listReferences } from "@/lib/sourcing/ui/data";
import { formatDate, caseTitle, humanize, READINESS_LABELS } from "@/lib/sourcing/ui/labels";
import { localPaths } from "@/lib/sourcing/ui/local-access";
import { localPageAllowed } from "@/lib/sourcing/ui/page-gate";
import { listUploads, uploadImageUrl } from "@/lib/sourcing/ui/uploads";

export const metadata: Metadata = { title: "Sourcing workspace" };

export default async function SourcingWorkspace() {
  if (!(await localPageAllowed())) return null;
  const paths = localPaths();
  const [references, uploads] = await Promise.all([listReferences(paths), listUploads(paths)]);
  const withResults = references.filter((r) => r.readiness === "results_available" && !r.synthetic);

  return (
    <div className="space-y-14">
      <section className="grid gap-8 lg:grid-cols-[1.2fr_1fr] lg:items-end">
        <div>
          <Eyebrow>Visual sourcing</Eyebrow>
          <h1 className="mt-3 max-w-3xl font-serif text-4xl leading-[1.1] text-ink sm:text-5xl">Find furniture designs across global suppliers using visual intelligence.</h1>
          <p className="mt-4 max-w-2xl text-lg leading-relaxed text-ink-soft">
            Start from a photograph of a piece you admire. Review marketplace candidates side by side with the original, with structural similarities and differences explained, and the listing and supplier details as reported.
          </p>
        </div>
        <dl className="grid grid-cols-3 gap-3 rounded-2xl border border-line bg-paper p-4 text-center">
          <div>
            <dt className="text-xs text-muted">References</dt>
            <dd className="mt-1 font-serif text-3xl">{references.filter((r) => !r.synthetic).length}</dd>
          </div>
          <div>
            <dt className="text-xs text-muted">With results</dt>
            <dd className="mt-1 font-serif text-3xl">{withResults.length}</dd>
          </div>
          <div>
            <dt className="text-xs text-muted">Staged uploads</dt>
            <dd className="mt-1 font-serif text-3xl">{uploads.length}</dd>
          </div>
        </dl>
      </section>

      <Notice tone="neutral" title="Automated marketplace discovery is awaiting authorized provider access">
        Candidates come from operator-recorded Alibaba.com listings. The automated provider integration is implemented but not approved for live use, so this workspace never searches marketplaces or makes paid model requests.
      </Notice>

      <section aria-labelledby="refs">
        <SectionTitle id="refs" eyebrow="Saved references" title="Furniture references" />
        {references.length === 0 ? (
          <Notice tone="neutral" title="No references yet">
            No saved image-understanding records were found in evals/local/predictions. Stage a photograph below; analysis is a separate, explicitly approved step.
          </Notice>
        ) : (
          <ul className="grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
            {references.map((r) => {
              const readiness = READINESS_LABELS[r.readiness];
              const latest = r.runs.find((x) => x.result.available);
              return (
                <li key={r.caseId}>
                  <Link href={`/sourcing/references/${r.caseId}`} className="group block h-full overflow-hidden rounded-2xl border border-line bg-paper transition-shadow hover:shadow-md">
                    <EvidenceImage src={r.photo.url} alt={`Reference photo: ${caseTitle(r.caseId)}`} zoomable={false} aspect="aspect-[5/4]" />
                    <div className="space-y-2 p-4">
                      <div className="flex flex-wrap items-center gap-2">
                        <Badge tone={readiness.tone}>{readiness.label}</Badge>
                        {r.synthetic ? <Badge tone="warn">Synthetic demo</Badge> : null}
                      </div>
                      <h3 className="font-serif text-xl text-ink group-hover:underline">{caseTitle(r.caseId)}</h3>
                      <p className="text-sm text-muted">
                        {r.category ? humanize(r.category) : "Category not recorded"}
                        {r.subtype ? ` · ${humanize(r.subtype)}` : ""}
                      </p>
                      <p className="text-xs text-muted">
                        {latest?.result.counts
                          ? `${latest.result.counts.candidates} candidate${latest.result.counts.candidates === 1 ? "" : "s"} · ${latest.result.counts.verified} visually verified in the latest result`
                          : `${r.candidates.state === "completed" ? `${r.candidates.count} candidate${r.candidates.count === 1 ? "" : "s"} recorded` : "No candidates collected"}${r.savedAssessments ? ` · ${r.savedAssessments} saved assessment${r.savedAssessments === 1 ? "" : "s"}` : " · No verification available"}`}
                        {latest ? ` · last result ${formatDate(latest.createdAt)}` : ""}
                      </p>
                    </div>
                  </Link>
                </li>
              );
            })}
          </ul>
        )}
      </section>

      <section aria-labelledby="upload" className="grid gap-8 lg:grid-cols-[1fr_1fr]">
        <div>
          <SectionTitle id="upload" eyebrow="New reference" title="Upload a furniture photograph" />
          <p className="mb-4 text-ink-soft">
            The photo is checked and saved privately on this computer. It is not sent anywhere, and it is not analysed automatically: image understanding and marketplace discovery are separate steps that need explicit approval.
          </p>
          <UploadDropzone />
        </div>
        <div>
          <SectionTitle eyebrow="Staged" title="Uploaded photographs" />
          {uploads.length === 0 ? (
            <p className="text-sm text-muted">No photographs staged yet.</p>
          ) : (
            <ul className="space-y-3">
              {uploads.slice(0, 8).map((u) => (
                <li key={u.id}>
                  <Link href={`/sourcing/uploads/${u.id}`} className="flex items-center gap-3 rounded-xl border border-line bg-paper p-2 pr-4 hover:shadow-sm">
                    <div className="w-20 shrink-0">
                      <EvidenceImage src={uploadImageUrl(u.id)} alt={`Uploaded photo ${u.originalName ?? u.id}`} zoomable={false} aspect="aspect-square" fit="cover" />
                    </div>
                    <div className="min-w-0">
                      <p className="truncate text-sm font-medium text-ink">{u.originalName ?? u.id}</p>
                      <p className="text-xs text-muted">Uploaded {formatDate(u.uploadedAt)}</p>
                      <p className="mt-1 inline-flex items-center gap-1 text-xs text-warn">
                        <Icon name="clock" className="h-3.5 w-3.5" /> Awaiting image understanding
                      </p>
                    </div>
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </div>
      </section>
    </div>
  );
}
