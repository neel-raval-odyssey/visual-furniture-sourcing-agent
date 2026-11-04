import Link from "next/link";
import type { IntakeEntry, IntakeState } from "@/lib/sourcing/ui/intake/intake";
import type { CollectionProduct, RevisionChanges } from "@/lib/sourcing/ui/intake/revision";
import { formatMoq, formatPrice } from "@/lib/sourcing/ui/labels";
import { resultsHref } from "@/lib/sourcing/ui/simple";
import { EvidenceImage } from "../evidence-image";
import { Badge, ExternalLink, Icon, Notice } from "../primitives";
import { RunOfflineButton } from "../run-offline-button";
import { Disclosure, PrimaryLink, SecondaryLink } from "../simple/parts";
import { AutomaticSearchPanel, SavedSearches, type AutomaticAvailability } from "./automatic-search-view";
import type { AssistView } from "@/lib/sourcing/browser-assist/session";
import { BrowserAssistant } from "./browser-assistant";
import { CataloguePanel, CatalogueSearches, type CatalogueSearchCard } from "./catalogue-search-view";
import { CompleteButton, CopyButton, DiscardButton, EntryActions, EntryForm, PhotoUpload, StartIntakeButton, StartRevisionButton, type EntryFormValues } from "./intake-controls";

/**
 * "Find similar products" for an analysed photo. Automatic marketplace search
 * is offered only when a source is actually eligible (its saved searches are a
 * separate product set); otherwise the person records products they found on
 * Alibaba.com themselves. A saved list can be
 * revised (photos, corrections, more products) as a new version; the saved
 * version is kept. A comparison is offered only once a product has a photo.
 */

export interface FindViewProps {
  caseId: string;
  photoUrl: string | null;
  furnitureType: string;
  queries: string[];
  /** Whether an automatic source is eligible, and the saved automatic searches (a separate candidate set). */
  automatic: AutomaticAvailability;
  /** Saved local-catalogue searches, newest first (a separate candidate set from the hand-collected list). */
  catalogue?: CatalogueSearchCard[];
  /** The supervised Alibaba.com window (you search; the app records the products you confirm). */
  browser?: { view: AssistView; photoPath: string | null };
  intake: IntakeState;
  /** The current saved product list (any intake path), or null. */
  collection: { products: CollectionProduct[]; withPhoto: number; revisable: boolean } | null;
  /** For an open revision: what saving it would change. */
  revisionChanges: RevisionChanges | null;
  /** The latest run with a result; `current` when it was made from the current saved list. */
  latestRun: { runId: string; current: boolean; shortlisted: number; compared: number } | null;
}

export const ALIBABA_SITE = "https://www.alibaba.com/";
export const ALIBABA_LENS = "https://sale.alibaba.com/p/lens/";

const intakeImage = (caseId: string, intakeId: string, entryId: string) => `/api/sourcing/evidence/intake/${caseId}/${intakeId}/${entryId}`;
const collectionImage = (caseId: string, index: number) => `/api/sourcing/evidence/collection/${caseId}/${index}`;
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

const formValues = (e: IntakeEntry): EntryFormValues => ({
  entryId: e.id,
  listingUrl: e.listingUrl,
  title: e.title,
  supplierName: e.supplierName ?? "",
  supplierProfileUrl: e.supplierProfileUrl ?? "",
  priceMin: e.price ? String(e.price.min) : "",
  priceMax: e.price?.max != null ? String(e.price.max) : "",
  currency: e.price?.currency ?? "",
  priceUnit: e.price?.unit ?? "",
  moqQuantity: e.minimumOrder ? String(e.minimumOrder.quantity) : "",
  moqUnit: e.minimumOrder?.unit ?? "",
  foundWith: e.foundWith,
  queryUsed: e.queryUsed ?? "",
  notes: e.notes ?? "",
  hasImage: Boolean(e.image),
});

function terms(price: { min: number; max?: number | null; currency?: string | null; unit?: string | null } | null, moq: { quantity: number; unit?: string | null } | null) {
  const p = price ? formatPrice({ min: price.min, max: price.max ?? null, currency: price.currency ?? null, unit: price.unit ?? null }) : "Price not recorded";
  return `${p} · ${moq ? `min. order ${formatMoq({ quantity: moq.quantity, unit: moq.unit ?? null })}` : "minimum order not recorded"} · as listed`;
}

function ProductRow({ title, supplier, termsLine, listingUrl, imageUrl, hasPhoto, children }: { title: string; supplier: string | null; termsLine: string; listingUrl: string; imageUrl: string | null; hasPhoto: boolean; children?: React.ReactNode }) {
  return (
    <li className="grid gap-4 rounded-2xl border border-line bg-paper p-4 sm:grid-cols-[9rem_minmax(0,1fr)]">
      <EvidenceImage src={hasPhoto ? imageUrl : null} alt={`Product photo: ${title}`} zoomable={false} aspect="aspect-square" />
      <div className="min-w-0 space-y-2">
        <div className="flex flex-wrap gap-2">
          <Badge tone="ok" icon="check">
            Product saved
          </Badge>
          {hasPhoto ? (
            <Badge tone="ok" icon="image">
              Ready to compare
            </Badge>
          ) : (
            <Badge tone="warn">Photo needed</Badge>
          )}
        </div>
        <p className="break-words font-medium text-ink">{title}</p>
        <p className="text-sm text-ink-soft">{supplier ?? "Supplier not recorded"}</p>
        <p className="text-xs text-muted">{termsLine}</p>
        <ExternalLink href={listingUrl} className="text-sm">
          Original listing
        </ExternalLink>
        {children}
      </div>
    </li>
  );
}

function Handoff({ furnitureType, queries }: { furnitureType: string; queries: string[] }) {
  return (
    <div className="space-y-4">
      <p className="text-ink-soft">
        Look for <span className="font-medium text-ink">{furnitureType.toLowerCase()}</span> designs like your photo on Alibaba.com&apos;s own website, using its camera (image) search with your photo, or one of these suggested searches.
      </p>
      {queries.length ? (
        <ul className="space-y-2">
          {queries.map((q) => (
            <li key={q} className="flex items-center justify-between gap-3 rounded-xl border border-line px-3 py-2">
              <span className="min-w-0 break-words text-sm text-ink">{q}</span>
              <CopyButton text={q} label={q} />
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-sm text-muted">No suggested searches were saved for this photo.</p>
      )}
      <div className="flex flex-wrap gap-4 text-sm">
        <ExternalLink href={ALIBABA_SITE}>Open Alibaba.com</ExternalLink>
        <ExternalLink href={ALIBABA_LENS}>Alibaba Lens (image search)</ExternalLink>
      </div>
      <p className="text-xs text-muted">Open a handful of promising listings (around 5–15). Copy only what each page shows; leave anything not shown empty. For a product photo, save the main image from the listing page. This app doesn&apos;t search or download anything itself.</p>
    </div>
  );
}

function ChangeSummary({ changes }: { changes: RevisionChanges }) {
  const parts = [
    changes.photosAdded ? plural(changes.photosAdded, "photo") + " added" : null,
    changes.photosReplaced ? plural(changes.photosReplaced, "photo") + " replaced" : null,
    changes.detailsChanged ? plural(changes.detailsChanged, "product") + " corrected" : null,
    changes.productsAdded ? plural(changes.productsAdded, "product") + " added" : null,
    changes.productsRemoved ? plural(changes.productsRemoved, "product") + " removed" : null,
  ].filter(Boolean);
  return <p className="text-ink-soft">{parts.length ? `Changes to save: ${parts.join(" · ")}.` : "No changes yet."}</p>;
}

export function FindView(props: FindViewProps) {
  const { caseId, photoUrl, furnitureType, queries, automatic, intake, collection, revisionChanges, latestRun } = props;
  const catalogue = props.catalogue ?? [];
  const browser = props.browser ? <BrowserAssistant caseId={caseId} view={props.browser.view} photoPath={props.browser.photoPath} /> : null;
  const draft = intake.draft;
  const revising = Boolean(draft?.basedOn);
  const draftEntries = draft?.entries ?? [];
  const n = collection?.products.length ?? 0;
  const k = collection?.withPhoto ?? 0;

  const heading = draft ? (revising ? "Add missing product photos" : "Add product leads") : collection ? "Products saved" : "Ready to find similar products";
  const lede = draft
    ? revising
      ? "Your saved products are kept as they are. Attach a photo you saved from each listing; you can also correct details or add another product. Nothing changes until you save this version."
      : "Record products you find on Alibaba.com. Nothing is searched automatically."
    : collection
      ? "These products were recorded by hand from Alibaba.com."
      : "Your furniture has been analyzed. Next: find similar products.";

  return (
    <div className="space-y-10">
      <Link href="/sourcing" className="inline-flex min-h-10 items-center gap-1 text-sm text-muted hover:text-ink">
        <Icon name="back" className="h-4 w-4" /> Back to Start
      </Link>
      <header className="grid items-center gap-8 md:grid-cols-[minmax(0,1.3fr)_minmax(0,1fr)]">
        <div className="space-y-3">
          <p className="text-sm font-medium text-accent">Your photo · {furnitureType}</p>
          <h1 className="font-serif text-4xl leading-tight text-ink sm:text-5xl">{heading}</h1>
          <p className="text-lg text-ink-soft">{lede}</p>
        </div>
        <EvidenceImage src={photoUrl} alt="Your furniture photo" label="Your photo" priority />
      </header>

      {!draft && !collection ? (
        <section className="grid gap-5 md:grid-cols-2">
          <CataloguePanel caseId={caseId} hasSearch={catalogue.length > 0} />
          {browser}
          <div className="space-y-3 rounded-2xl border border-line bg-paper p-5">
            <p className="font-medium text-ink">Add product leads</p>
            <p className="text-sm text-ink-soft">Search Alibaba.com yourself, then record each product you find, with its supplier and a photo. It takes a few minutes per product, with no forms to edit by hand.</p>
            <StartIntakeButton caseId={caseId} />
          </div>
          <AutomaticSearchPanel caseId={caseId} automatic={automatic} />
        </section>
      ) : !draft ? (
        <section className="grid gap-5 md:grid-cols-2">
          <CataloguePanel caseId={caseId} hasSearch={catalogue.length > 0} />
          {browser}
          <AutomaticSearchPanel caseId={caseId} automatic={automatic} />
        </section>
      ) : null}

      {draft && browser ? (
        <section aria-labelledby="browser-search" className="space-y-3">
          <h2 id="browser-search" className="font-serif text-2xl text-ink">
            Search Alibaba.com with your photo
          </h2>
          {browser}
        </section>
      ) : null}

      {!draft ? <CatalogueSearches caseId={caseId} searches={catalogue} furnitureType={furnitureType} /> : null}

      {!draft ? <SavedSearches caseId={caseId} searches={automatic.searches ?? []} /> : null}

      {draft && !revising ? (
        <>
          <section aria-labelledby="step-search" className="space-y-4 rounded-2xl border border-line bg-paper p-5">
            <h2 id="step-search" className="font-serif text-2xl text-ink">
              1. Search Alibaba.com yourself
            </h2>
            <Handoff furnitureType={furnitureType} queries={queries} />
          </section>
          <section aria-labelledby="step-record" className="space-y-4 rounded-2xl border border-line bg-paper p-5">
            <h2 id="step-record" className="font-serif text-2xl text-ink">
              2. Record a product you found
            </h2>
            <EntryForm caseId={caseId} intakeId={draft.intakeId} queries={queries} />
          </section>
          <section aria-labelledby="step-review" className="space-y-4">
            <h2 id="step-review" className="font-serif text-2xl text-ink">
              3. Review and finish ({plural(draftEntries.length, "product")})
            </h2>
            {draftEntries.length ? (
              <ul className="space-y-3">
                {draftEntries.map((e) => (
                  <ProductRow key={e.id} title={e.title} supplier={e.supplierName} termsLine={terms(e.price, e.minimumOrder)} listingUrl={e.listingUrl} imageUrl={intakeImage(caseId, draft.intakeId, e.id)} hasPhoto={Boolean(e.image)}>
                    <EntryActions caseId={caseId} intakeId={draft.intakeId} queries={queries} values={formValues(e)} />
                  </ProductRow>
                ))}
              </ul>
            ) : (
              <p className="text-sm text-muted">No products recorded yet.</p>
            )}
            {draftEntries.length && draftEntries.every((e) => !e.image) ? (
              <Notice tone="warn" title="No product has a photo yet">
                You can save the list now, but products can only be compared with your furniture once they have a photo.
              </Notice>
            ) : null}
            <CompleteButton caseId={caseId} intakeId={draft.intakeId} count={draftEntries.length} />
          </section>
        </>
      ) : null}

      {draft && revising ? (
        <>
          <section aria-labelledby="revise-products" className="space-y-4">
            <h2 id="revise-products" className="font-serif text-2xl text-ink">
              {plural(draftEntries.length, "product")} · {draftEntries.filter((e) => e.image).length} ready to compare
            </h2>
            <ul className="space-y-3">
              {draftEntries.map((e) => (
                <ProductRow key={e.id} title={e.title} supplier={e.supplierName} termsLine={terms(e.price, e.minimumOrder)} listingUrl={e.listingUrl} imageUrl={intakeImage(caseId, draft.intakeId, e.id)} hasPhoto={Boolean(e.image)}>
                  <div className="flex flex-wrap items-start gap-2">
                    <PhotoUpload caseId={caseId} intakeId={draft.intakeId} entryId={e.id} hasImage={Boolean(e.image)} title={e.title} />
                    <EntryActions caseId={caseId} intakeId={draft.intakeId} queries={queries} values={formValues(e)} />
                  </div>
                </ProductRow>
              ))}
            </ul>
          </section>
          <Disclosure title="Search tips" hint="Where to find each product's photo, and the suggested searches">
            <Handoff furnitureType={furnitureType} queries={queries} />
          </Disclosure>
          <Disclosure title="Add another product" hint="Record one more product you found on Alibaba.com">
            <EntryForm caseId={caseId} intakeId={draft.intakeId} queries={queries} />
          </Disclosure>
          <section aria-labelledby="revise-review" className="space-y-4 rounded-2xl border border-line bg-paper p-5">
            <h2 id="revise-review" className="font-serif text-2xl text-ink">
              Review and save this version
            </h2>
            {revisionChanges ? <ChangeSummary changes={revisionChanges} /> : null}
            <div className="flex flex-wrap items-start gap-4">
              <CompleteButton caseId={caseId} intakeId={draft.intakeId} count={draftEntries.length} label="Save this version" note="The previous version is kept unchanged. Earlier comparisons stay viewable." />
              <DiscardButton caseId={caseId} intakeId={draft.intakeId} />
            </div>
          </section>
        </>
      ) : null}

      {!draft && collection ? (
        <>
          <section aria-label="Progress" className="space-y-4">
            <p className="font-serif text-2xl text-ink">
              {plural(n, "product")} saved · {k} ready to compare
            </p>
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
              {[
                ["Products saved", String(n)],
                ["Ready to compare", String(k)],
                ["Photo needed", String(n - k)],
                ["Compared locally", latestRun?.current && latestRun.shortlisted ? String(latestRun.shortlisted) : "Not yet"],
              ].map(([label, value]) => (
                <div key={label} className="rounded-xl border border-line bg-paper p-4">
                  <p className="text-xs text-muted">{label}</p>
                  <p className="mt-1 font-serif text-xl text-ink">{value}</p>
                </div>
              ))}
            </div>
          </section>

          {k === 0 ? (
            <div className="space-y-4">
              <Notice tone="neutral" title="No product can be compared yet">
                Add at least one product photo to compare its design with your furniture.
              </Notice>
              {collection.revisable ? <StartRevisionButton caseId={caseId} label="Add product photos" /> : null}
            </div>
          ) : latestRun?.current && latestRun.shortlisted ? (
            <div className="space-y-4">
              <div className="flex flex-wrap items-start gap-4">
                <PrimaryLink href={resultsHref(caseId, latestRun.runId)}>View compared products</PrimaryLink>
                {k < n && collection.revisable ? <StartRevisionButton caseId={caseId} label="Add missing product photos" quiet /> : null}
              </div>
              {!latestRun.compared ? (
                <Notice tone="neutral" title="Compared locally — detailed verification pending">
                  Products with a photo have been put in order by a quick visual comparison on this computer. That order isn&apos;t a verified design match. A detailed AI comparison is a separate, paid step that needs its own approval.
                </Notice>
              ) : null}
            </div>
          ) : (
            <div className="space-y-3">
              <p className="text-ink-soft">
                {k === n ? "Every product has a photo." : `${plural(k, "product")} with a photo will be compared. ${plural(n - k, "product")} without a photo will stay in the list, not compared.`}
              </p>
              <div className="flex flex-wrap items-start gap-4">
                <RunOfflineButton caseId={caseId} simple label={k === n ? "Compare with your photo" : "Compare available products"} />
                {k < n && collection.revisable ? <StartRevisionButton caseId={caseId} label="Add missing product photos" quiet /> : null}
              </div>
            </div>
          )}

          {latestRun && !latestRun.current ? (
            <p className="text-sm text-muted">
              An earlier comparison was made before the latest changes.{" "}
              <Link href={resultsHref(caseId, latestRun.runId)} className="text-accent underline-offset-4 hover:underline">
                View earlier results
              </Link>
            </p>
          ) : null}

          <ul className="space-y-3">
            {collection.products.map((p) => (
              <ProductRow key={p.index} title={p.title} supplier={p.supplierName} termsLine={terms(p.price ?? null, p.minimumOrder ?? null)} listingUrl={p.listingUrl} imageUrl={collectionImage(caseId, p.index)} hasPhoto={Boolean(p.photo)} />
            ))}
          </ul>
          {k > 0 && k === n && collection.revisable ? <StartRevisionButton caseId={caseId} label="Correct or add products" quiet /> : null}
        </>
      ) : null}

      <Disclosure title="Advanced details" hint="Saved records, candidate files and commands">
        <div className="space-y-2 text-sm text-ink-soft">
          <p>
            Reference {caseId}. The current product list is an operator-assisted candidate manifest in evals/local/candidates/{caseId}.json, which the existing intake, shortlisting, verification and sourcing commands read. Each saved version is kept in evals/local/candidate-intake/{caseId}/.
          </p>
          <p>Automatic search: {automatic.available ? "eligible" : automatic.reason}</p>
          <p>Saved catalogue: searches read the completed product lists in evals/local/candidates/ and are saved separately in evals/local/discovery/{caseId}/; they never change any product list.</p>
          {automatic.providerLabel ? <p>Automatic source: {automatic.providerLabel}. Its searches are saved separately in evals/local/discovery/{caseId}/ and never change the hand-collected list.</p> : null}
          <SecondaryLink href={`/sourcing/references/${caseId}`}>Open in the advanced workspace</SecondaryLink>
        </div>
      </Disclosure>
    </div>
  );
}
