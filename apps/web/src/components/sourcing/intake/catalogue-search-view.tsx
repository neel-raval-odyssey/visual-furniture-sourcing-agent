import Link from "next/link";
import type { CatalogueSearchSummary } from "@/lib/sourcing/discovery/providers/local-catalogue/catalogue";
import { caseTitle, formatMoq, formatPrice } from "@/lib/sourcing/ui/labels";
import { resultsHref } from "@/lib/sourcing/ui/simple";
import { EvidenceImage } from "../evidence-image";
import { Badge, ExternalLink, Icon, Notice } from "../primitives";
import { PrimaryLink } from "../simple/parts";
import { CatalogueSearchButton } from "./catalogue-search-button";

/**
 * The saved catalogue on the "Find similar products" page: the action, and
 * each saved catalogue search with its stages as recorded in its files and in
 * the comparison made from it. Products come from records already saved on
 * this computer; they are never presented as a live marketplace search.
 */

export interface CatalogueSearchCard {
  discoveryId: string;
  createdAt: string;
  status: "planned" | "in_progress" | "pending_provider" | "completed" | "failed";
  summary: CatalogueSearchSummary | null;
  products: {
    index: number;
    title: string;
    listingUrl: string;
    imageUrl: string | null;
    supplierName: string | null;
    price: { min: number; max?: number | null; currency?: string | null; unit?: string | null } | null;
    minimumOrder: { quantity: number; unit?: string | null } | null;
    originCase: string | null;
    photoProblem: string | null;
  }[];
  /** The latest comparison made from exactly this product set, if any. */
  run: { runId: string; shortlisted: number; compared: number } | null;
}

export const CATALOGUE_EXPLANATION = "Find similar furniture among products already saved on this computer. No marketplace search or paid AI request.";

export function CataloguePanel({ caseId, hasSearch }: { caseId: string; hasSearch: boolean }) {
  return (
    <div className="space-y-3 rounded-2xl border border-accent/25 bg-accent-soft p-5">
      <p className="flex items-center gap-2 font-medium text-ink">
        <Icon name="image" className="h-4 w-4 text-accent" /> Search saved catalogue
      </p>
      <p className="text-sm text-ink-soft">{CATALOGUE_EXPLANATION}</p>
      <CatalogueSearchButton caseId={caseId} label={hasSearch ? "Search saved catalogue again" : "Search saved catalogue"} />
    </div>
  );
}

type StageState = "done" | "current" | "pending" | "failed" | "blocked";
const STAGE_TONE: Record<StageState, string> = { done: "text-ok", current: "text-accent", pending: "text-muted", failed: "text-bad", blocked: "text-warn" };
const STAGE_WORD: Record<StageState, string> = { done: "Done", current: "Next", pending: "Not yet", failed: "Failed", blocked: "Not possible" };
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

/** Stages read from the saved search and the comparison made from it; nothing is estimated. */
export function catalogueStages(card: CatalogueSearchCard): { label: string; state: StageState; note?: string }[] {
  const s = card.summary;
  const c = s?.counts ?? null;
  const failed = card.status === "failed";
  const withPhoto = c?.withLocalImage ?? 0;
  const run = card.run;
  return [
    { label: "Reference understood", state: "done" },
    {
      label: "Searching saved catalogue",
      state: failed ? "failed" : c ? "done" : "current",
      note: failed ? "The search stopped before it finished; nothing was sent anywhere. Search again." : c ? `${plural(c.selected, "relevant product")} among ${plural(c.considered, "saved product")}` : undefined,
    },
    {
      label: "Candidate photographs checked",
      state: !c ? "pending" : c.selected === 0 ? "blocked" : "done",
      note: c && c.selected > 0 ? `${withPhoto} of ${c.selected} with a usable photo` : undefined,
    },
    {
      label: "Comparing furniture designs locally",
      state: !c ? "pending" : withPhoto === 0 ? "blocked" : run && run.shortlisted > 0 ? "done" : "current",
      note: c && c.selected > 0 && withPhoto === 0 ? "No selected product has a photo to compare." : run && run.shortlisted > 0 ? `${plural(run.shortlisted, "product")} compared on this computer` : undefined,
    },
    {
      label: run && run.compared > 0 ? (run.compared === run.shortlisted ? "Detailed verification reused" : "Detailed verification partly reused") : "Detailed verification pending",
      state: run && run.compared > 0 ? "done" : "pending",
      note: run ? (run.compared > 0 ? `${plural(run.compared, "saved assessment")} reused; no new paid request` : "Needs a separate approval because it is a paid request.") : undefined,
    },
    { label: "Results ready", state: run ? "done" : "pending" },
  ];
}

function terms(p: CatalogueSearchCard["products"][number]) {
  const price = p.price ? formatPrice({ min: p.price.min, max: p.price.max ?? null, currency: p.price.currency ?? null, unit: p.price.unit ?? null }) : "Price not recorded";
  return `${price} · ${p.minimumOrder ? `min. order ${formatMoq({ quantity: p.minimumOrder.quantity, unit: p.minimumOrder.unit ?? null })}` : "minimum order not recorded"} · as listed when saved`;
}

const when = (iso: string) => new Date(iso).toLocaleString("en-GB", { dateStyle: "medium", timeStyle: "short", timeZone: "UTC" });

export function CatalogueSearches({ caseId, searches, furnitureType }: { caseId: string; searches: CatalogueSearchCard[]; furnitureType: string }) {
  if (!searches.length) return null;
  const [card, ...earlier] = searches;
  const c = card.summary?.counts ?? null;
  const withPhoto = card.products.filter((p) => p.imageUrl).length;
  return (
    <section aria-labelledby="catalogue-searches" className="space-y-4 rounded-2xl border border-line bg-paper p-5">
      <div className="space-y-1">
        <h2 id="catalogue-searches" className="font-serif text-2xl text-ink">
          Found in your saved catalogue
        </h2>
        <p className="text-sm text-ink-soft">
          Search of {when(card.createdAt)} UTC. Selected from products already saved on this computer — not a live Alibaba.com search. Prices and details are as listed when each product was saved.
        </p>
      </div>
      <ol className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
        {catalogueStages(card).map((stage) => (
          <li key={stage.label} className="rounded-xl border border-line px-3 py-2 text-sm">
            <span className={`font-medium ${STAGE_TONE[stage.state]}`}>{STAGE_WORD[stage.state]}</span> · <span className="text-ink">{stage.label}</span>
            {stage.note ? <span className="block text-xs text-muted">{stage.note}</span> : null}
          </li>
        ))}
      </ol>
      {c && c.selected === 0 ? (
        <Notice tone="neutral" title="No similar products in the saved catalogue">
          None of the {plural(c.considered, "product")} saved on this computer is a {furnitureType.toLowerCase()} or a closely related type, so nothing is shown rather than unrelated furniture.
        </Notice>
      ) : null}
      {c && c.selected > 0 && withPhoto === 0 ? (
        <Notice tone="warn" title="Photos needed before comparing">
          These saved products have no usable photo, so they can&apos;t be compared with your photo yet.
        </Notice>
      ) : null}
      {card.run ? (
        <div className="flex flex-wrap items-center gap-4">
          <PrimaryLink href={resultsHref(caseId, card.run.runId)}>
            View compared products <Icon name="forward" className="h-5 w-5" />
          </PrimaryLink>
          {card.run.compared === 0 ? <span className="text-sm text-ink-soft">Compared locally — detailed verification pending.</span> : null}
        </div>
      ) : null}
      {card.products.length ? (
        <ul className="grid gap-3 md:grid-cols-2">
          {card.products.map((p) => (
            <li key={p.listingUrl} className="grid grid-cols-[6rem_minmax(0,1fr)] gap-3 rounded-xl border border-line p-3">
              <EvidenceImage src={p.imageUrl} alt={`Product photo: ${p.title}`} zoomable={false} aspect="aspect-square" />
              <div className="min-w-0 space-y-1">
                <div className="flex flex-wrap gap-1.5">
                  <Badge tone="neutral">Saved catalogue</Badge>
                  {p.imageUrl ? (
                    <Badge tone="ok" icon="image">
                      Photo checked
                    </Badge>
                  ) : (
                    <Badge tone="warn">Photo needed</Badge>
                  )}
                </div>
                <p className="break-words text-sm font-medium text-ink">{p.title}</p>
                <p className="text-xs text-ink-soft">{p.supplierName ?? "Supplier not recorded"}</p>
                <p className="text-xs text-muted">{terms(p)}</p>
                {p.originCase ? <p className="text-xs text-muted">Saved with: {p.originCase === caseId ? "this photo's product list" : caseTitle(p.originCase)}</p> : null}
                {!p.imageUrl && p.photoProblem ? <p className="text-xs text-muted">Photo: {p.photoProblem}</p> : null}
                <ExternalLink href={p.listingUrl} className="text-sm">
                  Original listing
                </ExternalLink>
              </div>
            </li>
          ))}
        </ul>
      ) : null}
      {earlier.some((e) => e.run) ? (
        <p className="text-sm text-muted">
          Earlier catalogue searches:{" "}
          {earlier
            .filter((e) => e.run)
            .map((e, i) => (
              <span key={e.discoveryId}>
                {i ? " · " : ""}
                <Link href={resultsHref(caseId, e.run!.runId)} className="text-accent underline-offset-4 hover:underline">
                  {when(e.createdAt)} UTC
                </Link>
              </span>
            ))}
        </p>
      ) : null}
    </section>
  );
}
