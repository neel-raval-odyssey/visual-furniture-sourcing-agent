import type { FeaturedExample } from "@/lib/sourcing/ui/simple";
import { resultsHref } from "@/lib/sourcing/ui/simple";
import { EvidenceImage } from "../evidence-image";
import { Icon, Notice } from "../primitives";
import { UploadDropzone } from "../upload-dropzone";
import { PrimaryLink, SavedExampleNote } from "./parts";

/**
 * The start screen: one promise, one saved example, one main action. Uploading
 * is offered honestly as "save for later analysis" — it never starts sourcing.
 */
export function SimpleStart({ example }: { example: FeaturedExample | null }) {
  return (
    <div className="space-y-20">
      <section aria-labelledby="start" className="grid items-center gap-10 lg:min-h-[calc(100vh-14rem)] lg:grid-cols-[minmax(0,1fr)_minmax(0,1.1fr)] lg:gap-14">
        <div className="space-y-6">
          <h1 id="start" className="font-serif text-4xl leading-[1.08] text-ink sm:text-5xl lg:text-6xl">
            Find furniture that looks like this.
          </h1>
          <p className="max-w-xl text-lg leading-relaxed text-ink-soft sm:text-xl">Discover similar designs, compare the details, and explore suppliers.</p>
          {example ? (
            <div className="space-y-4">
              <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
                <PrimaryLink href={resultsHref(example.caseId, example.runId)}>
                  Explore example results <Icon name="forward" className="h-5 w-5" />
                </PrimaryLink>
                <a href="#upload" className="inline-flex min-h-12 items-center justify-center gap-2 rounded-full px-4 text-base font-medium text-ink underline-offset-4 hover:underline">
                  <Icon name="upload" className="h-5 w-5 text-accent" /> Upload your own photo
                </a>
              </div>
              <SavedExampleNote synthetic={example.synthetic} />
            </div>
          ) : (
            <Notice tone="neutral" title="No saved example is available yet">
              There are no saved results to show on this computer. You can still save a photo of your own below.
            </Notice>
          )}
        </div>
        {example ? (
          <figure className="space-y-3">
            <EvidenceImage src={example.photoUrl} alt={`Example furniture photo: ${example.title}`} label="Example photo" priority zoomable={false} aspect="aspect-[4/3]" />
            <figcaption className="text-sm text-muted">
              <span className="font-medium text-ink">{example.title}</span> · compared with {example.compared} of {example.candidates} saved Alibaba product{example.candidates === 1 ? "" : "s"}
            </figcaption>
          </figure>
        ) : null}
      </section>

      <section id="upload" aria-labelledby="upload-title" className="grid scroll-mt-8 gap-8 rounded-3xl border border-line bg-paper p-5 sm:p-8 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.2fr)] lg:items-center">
        <div className="space-y-3">
          <h2 id="upload-title" className="font-serif text-3xl text-ink">
            Try your own furniture photo
          </h2>
          <p className="text-ink-soft">
            Uploading saves your photo privately on this computer. You can then ask AI to analyze the furniture, after a confirmation. Searching for similar products isn&apos;t available for new photos yet.
          </p>
        </div>
        <UploadDropzone />
      </section>
    </div>
  );
}
