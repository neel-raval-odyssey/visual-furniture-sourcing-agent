import type { SupplierProfile } from "../domain";
import type { CuratedImport } from "../discovery/curated/curated-alibaba-adapter";
import type { SavedFingerprint } from "../understanding/saved/saved-fingerprint";
import { prioritizeImages, type ListingImagePlan, type ReferenceEvidence } from "./evidence";
import { PROTOCOL, PROTOCOL_VERSION, type DeviceRequest, type EmbedOkResponse, type EmbedRequest } from "./protocol";
import {
  IMAGE_SELECTION_POLICY,
  SCORE_INTERPRETATION,
  SHORTLIST_METHOD,
  type ExcludedListing,
  type ShortlistEntry,
  type VisualShortlist,
} from "./types";

/** Builds the embedding request: one group per listing that has at least one usable-looking local image. */
export function buildEmbedRequest(
  reference: ReferenceEvidence,
  plans: readonly ListingImagePlan[],
  model: { id: string; revision: string | null },
  device: DeviceRequest,
): EmbedRequest {
  return {
    protocol: PROTOCOL,
    protocolVersion: PROTOCOL_VERSION,
    model,
    device,
    reference: { id: reference.id, path: reference.path, sha256: reference.sha256 },
    groups: plans
      .filter((p) => p.images.length > 0)
      .map((p) => ({ id: p.listing.id, images: p.images.map(({ ref, path, sha256 }) => ({ ref, path, sha256 })) })),
  };
}

export interface BuildShortlistInput {
  caseId: string;
  saved: SavedFingerprint;
  imported: CuratedImport;
  plans: readonly ListingImagePlan[];
  response: EmbedOkResponse | null;
  topK: number;
  createdAt: string;
}

/**
 * Re-associates every score with its CandidateListing and supplier and
 * applies top-K. The order comes from the validated response (descending
 * cosine, ties by listing id); listings without a usable image are listed as
 * excluded with the reason, never given a score.
 */
export function buildVisualShortlist(input: BuildShortlistInput): VisualShortlist {
  const { saved, imported, plans, response, topK } = input;
  const suppliers = new Map<string, SupplierProfile>(imported.suppliers.map((s) => [s.id, s]));
  const plansById = new Map(plans.map((p) => [p.listing.id, p]));
  if (plans.some((p) => p.images.length > 0) && !response) throw new Error("An embedding response is required");

  const supplierOf = (supplierId: string | undefined) => {
    const s = supplierId ? suppliers.get(supplierId) : undefined;
    return s ? { id: s.id, name: s.name } : null;
  };

  const ranked: ShortlistEntry[] = [];
  const excluded: ExcludedListing[] = [];
  const responded = new Map((response?.groups ?? []).map((g) => [g.id, g]));

  for (const g of response?.groups ?? []) {
    if (g.status !== "embedded") continue;
    const plan = plansById.get(g.id);
    if (!plan) throw new Error(`Embedding result for unknown listing "${g.id}"`);
    const listing = plan.listing;
    const planned = plan.images.find((i) => i.ref === g.selectedImage.ref)!;
    const firstChoice = prioritizeImages(listing.images)[0];
    ranked.push({
      rank: ranked.length + 1,
      listingId: listing.id,
      marketplaceProductId: listing.marketplaceProductId ?? null,
      title: listing.title,
      listingUrl: listing.listingUrl,
      supplier: supplierOf(listing.supplierId),
      image: {
        ref: g.selectedImage.ref,
        role: planned.role,
        sha256: g.selectedImage.sha256,
        format: g.selectedImage.format,
        width: g.selectedImage.width,
        height: g.selectedImage.height,
        fallback: firstChoice?.uri !== `local-evidence:${g.selectedImage.ref}`,
      },
      rejectedImages: [...plan.rejected, ...g.rejectedImages],
      embeddingCosineSimilarity: g.embeddingCosineSimilarity,
      visualVerificationStatus: "not_assessed",
    });
  }

  for (const plan of [...plans].sort((a, b) => (a.listing.id < b.listing.id ? -1 : 1))) {
    const g = responded.get(plan.listing.id);
    if (g?.status === "embedded") continue;
    const base = {
      listingId: plan.listing.id,
      title: plan.listing.title,
      listingUrl: plan.listing.listingUrl,
      supplier: supplierOf(plan.listing.supplierId),
    };
    if (plan.listing.images.length === 0) {
      excluded.push({ ...base, reason: "no_image", rejectedImages: [] });
    } else {
      excluded.push({ ...base, reason: "no_usable_image", rejectedImages: [...plan.rejected, ...(g?.rejectedImages ?? [])] });
    }
  }

  const shortlist = ranked.slice(0, topK);
  const synthetic = imported.dataSource === "mock" || saved.fingerprint.source.dataSource === "mock";
  return {
    recordType: "visual_shortlist",
    schemaVersion: 1,
    caseId: input.caseId,
    createdAt: input.createdAt,
    synthetic,
    method: {
      kind: SHORTLIST_METHOD,
      score: "embeddingCosineSimilarity",
      ordering: "descending cosine similarity; ties by ascending listing id",
      interpretation: SCORE_INTERPRETATION,
    },
    model: response?.model ?? null,
    device: response?.device ?? null,
    preprocessing: response?.preprocessing ?? null,
    runtime: response?.runtime ?? null,
    reference: {
      referenceImageId: saved.reference.id,
      fingerprintId: saved.fingerprint.id,
      sha256: saved.record.image.sha256,
      image: response
        ? { format: response.reference.format, width: response.reference.width, height: response.reference.height }
        : null,
    },
    candidates: {
      manifestCapturedAt: imported.capturedAt,
      acquisitionMethod: imported.acquisitionMethod,
      providerId: imported.providers[0]?.providerId ?? "curated-alibaba",
    },
    imageSelectionPolicy: IMAGE_SELECTION_POLICY,
    topK,
    counts: {
      listings: plans.length,
      embedded: ranked.length,
      shortlisted: shortlist.length,
      belowTopK: ranked.length - shortlist.length,
      excluded: excluded.length,
    },
    shortlist,
    belowTopK: ranked.slice(topK).map((e) => e.listingId),
    excluded,
    visualVerification: {
      status: "not_assessed",
      note: "No detailed visual verification has run: no design similarity index, confidence or match classification exists for these candidates.",
    },
  };
}
