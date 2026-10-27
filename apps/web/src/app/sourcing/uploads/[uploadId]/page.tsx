import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { EvidenceImage } from "@/components/sourcing/evidence-image";
import { Badge, DataRow, Eyebrow, Icon, Notice } from "@/components/sourcing/primitives";
import { formatDate } from "@/lib/sourcing/ui/labels";
import { localPaths } from "@/lib/sourcing/ui/local-access";
import { localPageAllowed } from "@/lib/sourcing/ui/page-gate";
import { getUpload, uploadImageUrl } from "@/lib/sourcing/ui/uploads";

export const metadata: Metadata = { title: "Uploaded photograph" };

export default async function UploadPage({ params }: { params: Promise<{ uploadId: string }> }) {
  if (!(await localPageAllowed())) return null;
  const { uploadId } = await params;
  const upload = await getUpload(localPaths(), uploadId);
  if (!upload) notFound();

  return (
    <div className="space-y-8">
      <Link href="/sourcing" className="inline-flex min-h-10 items-center gap-1 text-sm text-muted hover:text-ink">
        <Icon name="back" className="h-4 w-4" /> Workspace
      </Link>
      <div className="grid gap-8 lg:grid-cols-[1.2fr_1fr]">
        <EvidenceImage src={uploadImageUrl(upload.id)} alt={`Uploaded photo ${upload.originalName ?? upload.id}`} label="Uploaded" priority aspect="aspect-[4/3]" />
        <div className="space-y-6">
          <div>
            <Eyebrow>New reference</Eyebrow>
            <h1 className="mt-2 font-serif text-3xl text-ink">Photo uploaded — awaiting image understanding</h1>
            <div className="mt-3">
              <Badge tone="warn" icon="clock">
                Not analysed · no candidates · no results
              </Badge>
            </div>
          </div>
          <Notice tone="info" title="What happens next">
            The photo is stored privately on this computer and has not been analysed or searched. Turning it into sourcing results needs, in order: an approved image-understanding request (a paid GPT-6 Luna call), authorized marketplace discovery, local image matching, and approved visual verification. Those steps are not enabled in this workspace yet.
          </Notice>
          <dl className="rounded-xl border border-line bg-paper px-4 py-1">
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
        </div>
      </div>
    </div>
  );
}
