import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { EvidenceImage } from "@/components/sourcing/evidence-image";
import { DataRow, Icon } from "@/components/sourcing/primitives";
import { Disclosure, PrimaryLink, SecondaryLink } from "@/components/sourcing/simple/parts";
import { formatDate } from "@/lib/sourcing/ui/labels";
import { localPaths } from "@/lib/sourcing/ui/local-access";
import { localPageAllowed } from "@/lib/sourcing/ui/page-gate";
import { getFeaturedExample, resultsHref } from "@/lib/sourcing/ui/simple";
import { getUpload, uploadImageUrl } from "@/lib/sourcing/ui/uploads";

export const metadata: Metadata = { title: "Photo saved" };

/** A staged upload. It is saved only: nothing has analysed or searched for it, and the page says so. */
export default async function UploadPage({ params }: { params: Promise<{ uploadId: string }> }) {
  if (!(await localPageAllowed())) return null;
  const { uploadId } = await params;
  const paths = localPaths();
  const [upload, example] = await Promise.all([getUpload(paths, uploadId), getFeaturedExample(paths)]);
  if (!upload) notFound();

  return (
    <div className="space-y-8">
      <Link href="/sourcing" className="inline-flex min-h-10 items-center gap-1 text-sm text-muted hover:text-ink">
        <Icon name="back" className="h-4 w-4" /> Start
      </Link>
      <div className="grid gap-8 lg:grid-cols-[minmax(0,1.2fr)_minmax(0,1fr)] lg:items-center">
        <EvidenceImage src={uploadImageUrl(upload.id)} alt={`Your uploaded photo${upload.originalName ? `: ${upload.originalName}` : ""}`} label="Your photo" priority aspect="aspect-[4/3]" />
        <div className="space-y-6">
          <div className="space-y-3">
            <p className="inline-flex items-center gap-1.5 text-sm font-medium text-ok">
              <Icon name="check" className="h-4 w-4" /> Saved privately on this computer
            </p>
            <h1 className="font-serif text-4xl text-ink">Photo saved successfully.</h1>
            <p className="text-xl text-ink-soft">Image analysis is the next step.</p>
          </div>
          <p className="text-ink-soft">
            Your photo hasn&apos;t been analysed or searched yet, so there are no similar products for it. Finding matches for new photos isn&apos;t available in this preview — you can explore the saved example in the meantime.
          </p>
          <div className="flex flex-col gap-3 sm:flex-row">
            {example ? <PrimaryLink href={resultsHref(example.caseId, example.runId)}>Explore example results</PrimaryLink> : null}
            <SecondaryLink href="/sourcing#upload">Save another photo</SecondaryLink>
          </div>
          <Disclosure title="Technical details">
            <p className="mb-3 text-sm text-ink-soft">
              Status: awaiting image understanding. Turning this photo into sourcing results needs, in order: an approved image-understanding request (a paid GPT-6 Luna call), authorized marketplace discovery, local image matching, and approved visual verification. None of these is enabled here.
            </p>
            <dl>
              <DataRow label="Upload id">
                <span className="font-mono text-xs">{upload.id}</span>
              </DataRow>
              <DataRow label="Original name">{upload.originalName ?? "Not provided"}</DataRow>
              <DataRow label="Uploaded">{formatDate(upload.uploadedAt)}</DataRow>
              <DataRow label="Format">
                {upload.mimeType} · {upload.width}×{upload.height} · {(upload.bytes / 1024).toFixed(0)} KB
              </DataRow>
              <DataRow label="SHA-256">
                <span className="break-all font-mono text-xs">{upload.sha256}</span>
              </DataRow>
            </dl>
          </Disclosure>
        </div>
      </div>
    </div>
  );
}
