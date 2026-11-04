import type { AutomaticSearchSummary } from "@/lib/sourcing/ui/discovery/automatic-search";
import { formatMoq, formatPrice } from "@/lib/sourcing/ui/labels";
import { resultsHref } from "@/lib/sourcing/ui/simple";
import { EvidenceImage } from "../evidence-image";
import { Badge, ExternalLink, Icon, Notice } from "../primitives";
import { RunOfflineButton } from "../run-offline-button";
import { PrimaryLink } from "../simple/parts";
import { FetchPhotosButton } from "./automatic-search-controls";

/**
 * Automatic search on the "Find similar products" page: whether a source is
 * available (never an enabled button that cannot search), and each saved
 * search with its real stages, read from its saved records. Products found
 * this way are labelled as found by a search index, not verified by
 * Alibaba.com, and are never mixed into the hand-collected list.
 */

export interface AutomaticSearchCard {
  discoveryId: string;
  createdAt: string;
  status: "planned" | "in_progress" | "pending_provider" | "completed" | "failed";
  unfinished: boolean;
  meaning: string;
  summary: AutomaticSearchSummary | null;
  products: { title: string; listingUrl: string; imageUrl: string | null; price: { min: number; max?: number | null; currency?: string | null; unit?: string | null } | null; minimumOrder: { quantity: number; unit?: string | null } | null }[];
  /** The latest comparison made from exactly this product set, if any. */
  run: { runId: string; shortlisted: number; compared: number } | null;
}

export interface AutomaticAvailability {
  available: boolean;
  reason: string;
  providerLabel?: string;
  searches?: AutomaticSearchCard[];
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

export function AutomaticSearchPanel({ caseId, automatic }: { caseId: string; automatic: AutomaticAvailability }) {
  return (
    <div className="rounded-2xl border border-line bg-paper p-5">
      <p className="flex items-center gap-2 font-medium text-ink">
        <Icon name={automatic.available ? "forward" : "lock"} className="h-4 w-4 text-muted" /> {automatic.available ? "Automatic marketplace search" : "Live Alibaba discovery — awaiting provider access"}
      </p>
      {automatic.available ? (
        <div className="mt-2 space-y-3">
          <p className="text-sm text-ink-soft">Searches Alibaba.com product pages using the description saved from your photo. You confirm before anything is sent.</p>
          <PrimaryLink href={`/sourcing/find/${caseId}/search`}>Search automatically</PrimaryLink>
        </div>
      ) : (
        <>
          <p className="mt-1 text-sm text-ink-soft">Not available yet. {automatic.reason}</p>
          <button type="button" disabled aria-disabled className="mt-3 inline-flex min-h-11 cursor-not-allowed items-center rounded-full border border-line px-4 text-sm text-muted">
            Search automatically (unavailable)
          </button>
        </>
      )}
    </div>
  );
}

type StageState = "done" | "current" | "pending" | "failed" | "blocked";
export function searchStages(card: AutomaticSearchCard): { label: string; state: StageState; note?: string }[] {
  const s = card.summary;
  const c = s?.counts ?? null;
  const withPhoto = c?.withLocalImage ?? 0;
  const failed = card.status === "failed";
  return [
    { label: "Searching products", state: failed ? "failed" : s && s.requests.succeeded > 0 ? "done" : card.unfinished ? "current" : "pending", note: failed ? "No search request succeeded — this is a failed search, not an empty result." : undefined },
    { label: "Reviewing returned listings", state: c ? "done" : failed ? "failed" : card.unfinished ? "pending" : "pending" },
    {
      label: "Preparing product photographs",
      state: !c ? "pending" : withPhoto > 0 ? "done" : s!.imageRetrieval === "not_approved" ? "blocked" : c.withImageUrl === 0 ? "blocked" : "pending",
      note: !c ? undefined : s!.imageRetrieval === "not_approved" ? "Downloading product photos has not been approved yet." : c.withImageUrl === 0 ? "The search returned no product photos." : undefined,
    },
    { label: "Comparing available images", state: card.run ? "done" : withPhoto > 0 ? "current" : "pending" },
    { label: "Detailed verification", state: card.run && card.run.compared > 0 ? "done" : "pending", note: card.run && card.run.compared === 0 ? "Pending — it needs a separate approval because it is a paid request." : undefined },
    { label: "Sourcing results ready", state: card.run ? "done" : "pending" },
  ];
}

const STAGE_TONE: Record<StageState, string> = { done: "text-ok", current: "text-accent", pending: "text-muted", failed: "text-bad", blocked: "text-warn" };
const STAGE_WORD: Record<StageState, string> = { done: "Done", current: "Next", pending: "Not yet", failed: "Failed", blocked: "Waiting" };

function terms(p: AutomaticSearchCard["products"][number]) {
  const price = p.price ? formatPrice({ min: p.price.min, max: p.price.max ?? null, currency: p.price.currency ?? null, unit: p.price.unit ?? null }) : "Price not listed in the search result";
  return `${price}${p.minimumOrder ? ` · min. order ${formatMoq({ quantity: p.minimumOrder.quantity, unit: p.minimumOrder.unit ?? null })}` : ""}${p.price || p.minimumOrder ? " · as indexed, may be out of date" : ""}`;
}

export function SavedSearches({ caseId, searches }: { caseId: string; searches: AutomaticSearchCard[] }) {
  if (!searches.length) return null;
  return (
    <section aria-labelledby="auto-searches" className="space-y-6">
      <h2 id="auto-searches" className="font-serif text-2xl text-ink">
        Found by automatic search
      </h2>
      {searches.map((card) => {
        const c = card.summary?.counts ?? null;
        const withPhoto = card.products.filter((p) => p.imageUrl).length;
        return (
          <article key={card.discoveryId} className="space-y-4 rounded-2xl border border-line bg-paper p-5">
            <div className="space-y-1">
              <p className="font-medium text-ink">Search of {new Date(card.createdAt).toLocaleString("en-GB", { dateStyle: "medium", timeStyle: "short", timeZone: "UTC" })} UTC</p>
              <p className="text-sm text-ink-soft">Found through a web search index restricted to Alibaba.com product pages — not by Alibaba.com, and not a check of the listing or its supplier.</p>
            </div>
            <ol className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
              {searchStages(card).map((stage) => (
                <li key={stage.label} className="rounded-xl border border-line px-3 py-2 text-sm">
                  <span className={`font-medium ${STAGE_TONE[stage.state]}`}>{STAGE_WORD[stage.state]}</span> · <span className="text-ink">{stage.label}</span>
                  {stage.note ? <span className="block text-xs text-muted">{stage.note}</span> : null}
                </li>
              ))}
            </ol>
            {c ? (
              <p className="text-sm text-ink-soft">
                {plural(c.uniqueProducts, "product")} found · {withPhoto} with a photo · {plural(c.withPrice, "listed price")} · supplier not reported by this source
              </p>
            ) : (
              <p className="text-sm text-ink-soft">{card.meaning}</p>
            )}
            {c && c.uniqueProducts === 0 ? <Notice tone="neutral" title="No matching Alibaba.com product pages were returned">The search ran but returned no furniture product listings to keep.</Notice> : null}
            {c && withPhoto === 0 && c.uniqueProducts > 0 ? (
              card.summary!.imageRetrieval === "not_approved" ? (
                <Notice tone="warn" title="Photos needed before comparing">These products were found, but downloading their photos has not been approved, so they cannot be compared with your photo yet.</Notice>
              ) : (
                <FetchPhotosButton caseId={caseId} discoveryId={card.discoveryId} />
              )
            ) : null}
            <div className="flex flex-wrap items-start gap-3">
              {card.run ? <PrimaryLink href={resultsHref(caseId, card.run.runId)}>View compared products</PrimaryLink> : null}
              {withPhoto > 0 ? (
                <RunOfflineButton
                  caseId={caseId}
                  simple
                  discoveryId={card.discoveryId}
                  label={card.run ? "Compare again" : withPhoto === card.products.length ? "Compare these products with your photo" : "Compare products that have a photo"}
                />
              ) : null}
            </div>
            {card.products.length ? (
              <ul className="grid gap-3 md:grid-cols-2">
                {card.products.map((p) => (
                  <li key={p.listingUrl} className="grid grid-cols-[6rem_minmax(0,1fr)] gap-3 rounded-xl border border-line p-3">
                    <EvidenceImage src={p.imageUrl} alt={`Product photo: ${p.title}`} zoomable={false} aspect="aspect-square" />
                    <div className="min-w-0 space-y-1">
                      <div className="flex flex-wrap gap-1.5">
                        <Badge tone="neutral">Found automatically</Badge>
                        {p.imageUrl ? <Badge tone="ok" icon="image">Ready to compare</Badge> : <Badge tone="warn">Photo needed</Badge>}
                      </div>
                      <p className="break-words text-sm font-medium text-ink">{p.title}</p>
                      <p className="text-xs text-muted">{terms(p)}</p>
                      <ExternalLink href={p.listingUrl} className="text-sm">
                        Original listing
                      </ExternalLink>
                    </div>
                  </li>
                ))}
              </ul>
            ) : null}
          </article>
        );
      })}
    </section>
  );
}
