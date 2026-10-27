import Link from "next/link";
import type { FurnitureFingerprint } from "@/lib/sourcing/domain";
import type { AnalysisStatus } from "@/lib/sourcing/ui/analysis/analyze-upload";
import type { AnalysisAttempt } from "@/lib/sourcing/ui/analysis/attempts";
import { failureText, NOT_IDENTIFIED_TEXT, summarizeFingerprint, TRY_AGAIN_TEXT, UNCERTAIN_TEXT, type PlainFeature } from "@/lib/sourcing/ui/analysis/present";
import { formatDate } from "@/lib/sourcing/ui/labels";
import { resultsHref, type FeaturedExample } from "@/lib/sourcing/ui/simple";
import { uploadImageUrl, type UploadRecord } from "@/lib/sourcing/ui/uploads";
import { EvidenceImage } from "../evidence-image";
import { DataRow, Icon, Notice } from "../primitives";
import { Disclosure, PrimaryLink, SecondaryLink } from "../simple/parts";
import { AnalysisRefresher } from "./analysis-refresher";
import { AnalyzePanel, AnalyzingNotice, FinishSavingButton } from "./analyze-panel";

/**
 * The upload page: the photo, then exactly one of the recorded analysis
 * states. Everything shown comes from the upload record, the attempt journal
 * and the saved fingerprint; nothing is inferred or invented here.
 */
export function UploadAnalysisView({ upload, status, fingerprint, example }: { upload: UploadRecord; status: AnalysisStatus; fingerprint: FurnitureFingerprint | null; example: FeaturedExample | null }) {
  const analyzed = status.state === "analyzed" && fingerprint;
  return (
    <div className="space-y-10">
      <Link href="/sourcing" className="inline-flex min-h-10 items-center gap-1 text-sm text-muted hover:text-ink">
        <Icon name="back" className="h-4 w-4" /> Back to Start
      </Link>
      <div className="grid gap-8 lg:grid-cols-[minmax(0,1.1fr)_minmax(0,1fr)] lg:items-start">
        <figure className="space-y-2">
          <EvidenceImage src={uploadImageUrl(upload.id)} alt={`Your uploaded photo${upload.originalName ? `: ${upload.originalName}` : ""}`} label="Your photo" priority aspect="aspect-[4/3]" />
          {upload.originalName ? <figcaption className="text-sm text-muted">{upload.originalName}</figcaption> : null}
        </figure>
        <div className="space-y-6">
          <StatePanel upload={upload} status={status} fingerprint={fingerprint} example={example} />
        </div>
      </div>
      {analyzed ? <AnalyzedDetails fingerprint={fingerprint} /> : null}
      <TechnicalDetails upload={upload} attempt={"attempt" in status ? status.attempt : "previous" in status ? status.previous : null} />
    </div>
  );
}

function Heading({ eyebrow, title, tone = "ok" }: { eyebrow?: string; title: string; tone?: "ok" | "muted" }) {
  return (
    <div className="space-y-2">
      {eyebrow ? (
        <p className={`inline-flex items-center gap-1.5 text-sm font-medium ${tone === "ok" ? "text-ok" : "text-muted"}`}>
          <Icon name={tone === "ok" ? "check" : "info"} className="h-4 w-4" /> {eyebrow}
        </p>
      ) : null}
      <h1 className="font-serif text-3xl leading-tight text-ink sm:text-4xl">{title}</h1>
    </div>
  );
}

function StatePanel({ upload, status, fingerprint, example }: { upload: UploadRecord; status: AnalysisStatus; fingerprint: FurnitureFingerprint | null; example: FeaturedExample | null }) {
  const exampleLink = example ? <SecondaryLink href={resultsHref(example.caseId, example.runId)}>Explore example results</SecondaryLink> : null;
  switch (status.state) {
    case "ready":
      return (
        <>
          <Heading eyebrow="Saved privately on this computer" title="Photo saved successfully" />
          <p className="text-lg text-ink-soft">AI can identify the furniture&apos;s shape, materials, colours and distinctive design details.</p>
          <AnalyzePanel uploadId={upload.id} attemptKey={status.attemptKey} model={status.request.model} />
          <p className="text-sm text-muted">Nothing is sent until you confirm. Finding similar products comes after analysis and isn&apos;t available for new photos yet.</p>
        </>
      );
    case "unavailable":
      return (
        <>
          <Heading eyebrow="Saved privately on this computer" title="Photo saved successfully" />
          <Notice tone={status.problem === "api_key_missing" ? "neutral" : "warn"} title="Analysis isn't available for this photo">
            {status.message}
            {status.problem === "api_key_missing" ? (
              <span className="mt-1 block">
                To enable it, add <code className="rounded bg-sand px-1">OPENAI_API_KEY</code> to <code className="rounded bg-sand px-1">apps/web/.env.local</code> and restart <code className="rounded bg-sand px-1">pnpm dev:local</code>.
              </span>
            ) : null}
          </Notice>
          <div className="flex flex-wrap gap-3">{exampleLink}</div>
        </>
      );
    case "analyzing":
      return (
        <>
          <Heading eyebrow="Analysis confirmed" title="Analyzing your photo" tone="muted" />
          <AnalyzingNotice />
          <AnalysisRefresher uploadId={upload.id} />
        </>
      );
    case "analyzed":
      if (!fingerprint) {
        return (
          <Notice tone="warn" title="The analysis was saved, but it can't be read back">
            Open the advanced workspace to check this reference.
          </Notice>
        );
      }
      return <AnalyzedSummary fingerprint={fingerprint} caseId={status.attempt.caseId} />;
    case "registration_pending":
      return (
        <>
          <Heading eyebrow="Analysis received" title="Almost done: saving your furniture reference" tone="muted" />
          <Notice tone="warn" title="The analysis was saved, but it couldn't be added to your references yet">
            {status.attempt.problem ?? "Saving didn't finish."} Finishing it doesn&apos;t send anything to OpenAI.
          </Notice>
          <FinishSavingButton uploadId={upload.id} />
        </>
      );
    case "not_identified": {
      const text = NOT_IDENTIFIED_TEXT[status.attempt.outcome?.modelOutcome ?? "no_furniture"] ?? NOT_IDENTIFIED_TEXT.no_furniture;
      return (
        <>
          <Heading eyebrow="Analysis finished" title={text.title} tone="muted" />
          <p className="text-ink-soft">{text.body}</p>
          <p className="text-sm text-muted">{TRY_AGAIN_TEXT}</p>
          <div className="flex flex-wrap gap-3">
            <SecondaryLink href="/sourcing#upload">Upload another photo</SecondaryLink>
          </div>
        </>
      );
    }
    case "failed":
      return (
        <>
          <Heading eyebrow="Analysis didn't succeed" title="We couldn't analyze this photo" tone="muted" />
          <Notice tone="warn" title={failureText(status.attempt)}>
            No furniture reference was saved. A new request is not sent automatically.
          </Notice>
          <p className="text-sm text-muted">{TRY_AGAIN_TEXT}</p>
        </>
      );
    case "uncertain":
      return (
        <>
          <Heading eyebrow="Outcome unknown" title="We couldn't confirm the analysis" tone="muted" />
          <Notice tone="warn" title={UNCERTAIN_TEXT}>
            The attempt is recorded and won&apos;t be repeated automatically. You can check the OpenAI usage dashboard for this time before deciding to try again.
          </Notice>
          <p className="text-sm text-muted">{TRY_AGAIN_TEXT}</p>
        </>
      );
    case "blocked":
      return (
        <Notice tone="bad" title="Analysis is paused for this photo">
          {status.message}
        </Notice>
      );
  }
}

function FeatureList({ features }: { features: PlainFeature[] }) {
  return (
    <ul className="space-y-1.5">
      {features.map((f, i) => (
        <li key={i} className="text-ink-soft">
          <span className="font-medium text-ink">{f.label}</span>
          {f.value ? `: ${f.value}` : ""}
          {f.qualifier ? <span className="ml-1.5 rounded-full bg-sand px-2 py-0.5 text-xs text-muted">{f.qualifier}</span> : null}
          {f.note ? <span className="block text-sm text-muted">{f.note}</span> : null}
        </li>
      ))}
    </ul>
  );
}

function AnalyzedSummary({ fingerprint, caseId }: { fingerprint: FurnitureFingerprint; caseId: string }) {
  const s = summarizeFingerprint(fingerprint);
  return (
    <>
      <Heading eyebrow="Analysis complete · saved privately" title="Your furniture has been analyzed" />
      <p className="text-lg text-ink-soft">Finding similar products is the next step.</p>
      <div className="rounded-2xl border border-line bg-paper p-5">
        <p className="text-sm text-muted">Furniture type</p>
        <p className="mt-0.5 font-serif text-2xl text-ink">
          {s.type}
          {s.subtype ? <span className="text-ink-soft"> · {s.subtype}</span> : null}
        </p>
        {s.distinctive.length ? (
          <div className="mt-4">
            <p className="mb-1.5 text-sm font-medium text-ink">What makes it distinctive</p>
            <FeatureList features={s.distinctive} />
          </div>
        ) : null}
      </div>
      <div className="rounded-2xl border border-accent/25 bg-accent-soft p-5">
        <p className="flex items-center gap-2 font-medium text-ink">
          <Icon name="clock" className="h-4 w-4 text-accent" /> Ready for product discovery
        </p>
        <p className="mt-1 text-sm text-ink-soft">
          This photo is now a saved furniture reference. Finding genuine marketplace products for it is the next step, and isn&apos;t available automatically for new photos yet. No products have been searched for or matched.
        </p>
      </div>
      <div className="flex flex-wrap gap-3">
        <PrimaryLink href="#furniture-details">View furniture details</PrimaryLink>
        <SecondaryLink href={`/sourcing/references/${caseId}`}>Advanced details</SecondaryLink>
      </div>
    </>
  );
}

function AnalyzedDetails({ fingerprint }: { fingerprint: FurnitureFingerprint }) {
  const s = summarizeFingerprint(fingerprint);
  return (
    <section id="furniture-details" aria-labelledby="details-title" className="scroll-mt-8 space-y-6">
      <h2 id="details-title" className="font-serif text-2xl text-ink sm:text-3xl">
        Furniture details
      </h2>
      <div className="grid gap-5 md:grid-cols-3">
        <div className="rounded-2xl border border-line bg-paper p-5">
          <h3 className="mb-2 font-medium text-ink">Shape and structure</h3>
          {s.structure.length ? <FeatureList features={s.structure} /> : <p className="text-sm text-muted">None recorded.</p>}
        </div>
        <div className="rounded-2xl border border-line bg-paper p-5">
          <h3 className="mb-2 font-medium text-ink">Colour and materials</h3>
          {s.appearance.length ? <FeatureList features={s.appearance} /> : <p className="text-sm text-muted">None recorded.</p>}
        </div>
        <div className="rounded-2xl border border-line bg-paper p-5">
          <h3 className="mb-2 font-medium text-ink">Not visible in this photo</h3>
          {s.uncertain.length ? <FeatureList features={s.uncertain} /> : <p className="text-sm text-muted">Nothing noted as hidden or unclear.</p>}
        </div>
      </div>
      <Disclosure title="See every recorded detail" hint="All observations, including likely and not-visible ones">
        <div className="grid gap-6 md:grid-cols-3">
          {s.all.map((g) => (
            <div key={g.title}>
              <h3 className="mb-2 font-medium text-ink">{g.title}</h3>
              {g.features.length ? <FeatureList features={g.features} /> : <p className="text-sm text-muted">None recorded.</p>}
            </div>
          ))}
        </div>
        <p className="mt-4 text-xs text-muted">“Likely” means the AI inferred it rather than seeing it directly. These are automated observations from one photo, not verified facts.</p>
      </Disclosure>
    </section>
  );
}

function TechnicalDetails({ upload, attempt }: { upload: UploadRecord; attempt: AnalysisAttempt | null }) {
  const usage = attempt?.response?.usage;
  return (
    <Disclosure title="Technical details" hint="Upload, request and usage records">
      <dl>
        <DataRow label="Upload id">
          <span className="font-mono text-xs">{upload.id}</span>
        </DataRow>
        <DataRow label="Uploaded">{formatDate(upload.uploadedAt)}</DataRow>
        <DataRow label="Format">
          {upload.mimeType} · {upload.width}×{upload.height} · {(upload.bytes / 1024).toFixed(0)} KB
        </DataRow>
        <DataRow label="Image SHA-256">
          <span className="break-all font-mono text-xs">{upload.sha256}</span>
        </DataRow>
        {attempt ? (
          <>
            <DataRow label="Attempt">
              #{attempt.attempt} · {attempt.state} · reserved {formatDate(attempt.reservedAt)}
              {attempt.sendStartedAt ? ` · sent ${formatDate(attempt.sendStartedAt)}` : " · not sent"}
              {attempt.finishedAt ? ` · finished ${formatDate(attempt.finishedAt)}` : ""}
            </DataRow>
            <DataRow label="Request">
              {attempt.request.model}, instructions {attempt.request.instructionsVersion}, image detail {attempt.request.imageDetail}, reasoning {attempt.request.reasoningEffort}, max {attempt.request.maxOutputTokens} output tokens, timeout {attempt.request.timeoutMs / 1000}s, no retries, store false
            </DataRow>
            <DataRow label="Response">
              {attempt.response?.responseId ? <span className="break-all font-mono text-xs">{attempt.response.responseId}</span> : "None received"}
              {attempt.response?.responseModel ? ` · ${attempt.response.responseModel}` : ""}
              {attempt.response?.durationMs != null ? ` · ${(attempt.response.durationMs / 1000).toFixed(1)}s` : ""}
            </DataRow>
            <DataRow label="Reported usage">
              {usage ? `input ${usage.inputTokens}, output ${usage.outputTokens}${usage.reasoningTokens !== undefined ? ` (reasoning ${usage.reasoningTokens})` : ""}, total ${usage.totalTokens} tokens` : "Not reported"}
            </DataRow>
            {attempt.outcome?.errorCategory ? (
              <DataRow label="Error">
                {attempt.outcome.errorCategory}
                {attempt.outcome.message ? `: ${attempt.outcome.message}` : ""}
                {attempt.outcome.requestId ? ` (request ${attempt.outcome.requestId})` : ""}
              </DataRow>
            ) : null}
            {attempt.outcome?.modelReason ? <DataRow label="Model's reason (untrusted)">{attempt.outcome.modelReason}</DataRow> : null}
            <DataRow label="Reference">
              <span className="font-mono text-xs">{attempt.caseId}</span> · {attempt.referenceId}
              {attempt.predictionFile ? ` · ${attempt.predictionFile}` : ""}
            </DataRow>
          </>
        ) : (
          <DataRow label="Analysis">Not requested</DataRow>
        )}
      </dl>
    </Disclosure>
  );
}
