import type { Metadata } from "next";
import { join } from "node:path";
import { notFound } from "next/navigation";
import { UploadAnalysisView } from "@/components/sourcing/analysis/upload-analysis-view";
import type { FurnitureFingerprint } from "@/lib/sourcing/domain";
import { getAnalysisStatus } from "@/lib/sourcing/ui/analysis/analyze-upload";
import { localPaths } from "@/lib/sourcing/ui/local-access";
import { localPageAllowed } from "@/lib/sourcing/ui/page-gate";
import { getFeaturedExample } from "@/lib/sourcing/ui/simple";
import { getUpload } from "@/lib/sourcing/ui/uploads";
import { loadSavedFingerprint, SavedRunError } from "@/lib/sourcing/understanding/saved/saved-fingerprint";

export const metadata: Metadata = { title: "Your photo" };

/** A staged upload and its recorded analysis state. Rendering reads files only; it never contacts OpenAI. */
export default async function UploadPage({ params }: { params: Promise<{ uploadId: string }> }) {
  if (!(await localPageAllowed())) return null;
  const { uploadId } = await params;
  const paths = localPaths();
  const upload = await getUpload(paths, uploadId);
  if (!upload) notFound();
  const [status, example] = await Promise.all([getAnalysisStatus(paths, upload.id), getFeaturedExample(paths)]);
  let fingerprint: FurnitureFingerprint | null = null;
  if (status.state === "analyzed") {
    try {
      // The same loader every other reference uses.
      fingerprint = (await loadSavedFingerprint(join(paths.predictions, `${status.attempt.caseId}.json`), status.attempt.caseId)).fingerprint;
    } catch (error) {
      if (!(error instanceof SavedRunError)) throw error;
    }
  }
  return <UploadAnalysisView upload={upload} status={status} fingerprint={fingerprint} example={example} />;
}
