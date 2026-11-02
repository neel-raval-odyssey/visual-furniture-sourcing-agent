import { createHash, randomUUID } from "node:crypto";
import { copyFile, link, mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { importCuratedCandidates } from "../../discovery/curated/curated-alibaba-adapter";
import { CAPTURE_TOOLS, candidateIdentity, candidateManifestSchema, type CandidateManifest, type ManifestCandidate, type ManifestSupplier } from "../../discovery/curated/manifest";
import { canonicalUrl, checkMarketplaceUrl, productIdFromListingUrl } from "../../discovery/curated/marketplace-urls";
import { ImageInputError, validateImageBytes } from "../../image-input/image-content";
import { inspectImage } from "../../image-input/inspect";
import { resolveReferenceImage } from "../../shortlisting/evidence";
import { loadSavedFingerprint, SavedRunError, type SavedFingerprint } from "../../understanding/saved/saved-fingerprint";
import { checkManifest, loadManifest } from "../../cli/source-candidates";
import { writeExclusive, writeReplace } from "../analysis/attempts";
import { withFileLock } from "../analysis/register";
import { CASE_ID, type Paths } from "../data";
import { readConfined } from "../evidence";

/**
 * Operator-assisted candidate intake in the web app: a person searches
 * Alibaba.com with its ordinary website, then records each product here
 * (listing URL, title, supplier, price and MOQ as shown, and a product photo
 * they saved). Drafts live in evals/local/candidate-intake/<case>/<intake>/;
 * completing one publishes a standard operator_assisted candidate manifest at
 * evals/local/candidates/<case>.json with images in candidates/<case>/, where
 * source:candidates, shortlist:images, verify:visual and source:auto read it.
 * Nothing here searches, fetches or downloads anything; nothing is invented.
 */

export const MAX_ENTRIES = 20;
export const MAX_PRODUCT_IMAGE_BYTES = 10 * 1024 * 1024;
export const INTAKE_ID = /^int-[0-9tz-]+-[0-9a-f]{8}$/;
export const ENTRY_ID = /^p\d{2}$/;
const EXT = { "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp" } as const;

/** How the operator found a listing on Alibaba.com's own site (subset of the manifest's capture tools). */
export const FOUND_WITH = ["alibaba_image_search", "alibaba_keyword_search", "alibaba_lens", "other"] as const satisfies readonly (typeof CAPTURE_TOOLS)[number][];

const entryImageSchema = z.strictObject({
  file: z.string().regex(/^images\/p\d{2}-[0-9a-f]{8}\.(png|jpg|webp)$/),
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
  mimeType: z.enum(["image/png", "image/jpeg", "image/webp"]),
  bytes: z.int().positive(),
  width: z.int().positive(),
  height: z.int().positive(),
  /** Display only; never used to build a path. */
  originalName: z.string().max(120).nullable(),
  /** Set when the photo came from the published collection (revisions): its path relative to the candidates folder. */
  publishedPath: z.string().nullable().optional(),
});

export const intakeEntrySchema = z.strictObject({
  id: z.string().regex(ENTRY_ID),
  listingUrl: z.string(),
  marketplaceProductId: z.string().nullable(),
  title: z.string().min(1).max(300),
  supplierName: z.string().max(200).nullable(),
  supplierProfileUrl: z.string().nullable(),
  price: z.strictObject({ min: z.number().nonnegative(), max: z.number().nonnegative().nullable(), currency: z.string().regex(/^[A-Z]{3}$/).nullable(), unit: z.string().max(40).nullable() }).nullable(),
  minimumOrder: z.strictObject({ quantity: z.int().positive(), unit: z.string().max(40).nullable() }).nullable(),
  foundWith: z.enum(FOUND_WITH),
  queryUsed: z.string().max(200).nullable(),
  notes: z.string().max(1000).nullable(),
  image: entryImageSchema.nullable(),
  /** Revisions: manifest data the form does not edit, republished unchanged (validated again on publish). */
  carried: z
    .strictObject({
      category: z.string().nullable(),
      attributes: z.record(z.string(), z.string()).nullable(),
      priceTiers: z.array(z.unknown()).nullable(),
      otherImages: z.array(z.unknown()),
      supplier: z.record(z.string(), z.unknown()).nullable(),
    })
    .nullable()
    .optional(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type IntakeEntry = z.output<typeof intakeEntrySchema>;

export const intakeSessionSchema = z.strictObject({
  recordType: z.literal("candidate_intake_session"),
  schemaVersion: z.literal(1),
  intakeId: z.string().regex(INTAKE_ID),
  caseId: z.string().regex(CASE_ID),
  acquisitionMethod: z.literal("operator_assisted"),
  referenceImageId: z.string(),
  fingerprintId: z.string(),
  referenceSha256: z.string().regex(/^[0-9a-f]{64}$/),
  status: z.enum(["draft", "completed", "discarded"]),
  /** Increases with every saved change. */
  revision: z.int().nonnegative(),
  createdAt: z.string(),
  updatedAt: z.string(),
  completedAt: z.string().nullable(),
  entries: z.array(intakeEntrySchema).max(MAX_ENTRIES),
  published: z
    .strictObject({ manifestFile: z.string(), manifestSha256: z.string(), imagesDir: z.string(), summaryFile: z.string(), previousManifestSha256: z.string().nullable().optional() })
    .nullable(),
  /** A revision of a published collection: the exact collection it started from and its immutable snapshot. */
  basedOn: z.strictObject({ manifestSha256: z.string().regex(/^[0-9a-f]{64}$/), snapshotFile: z.string(), sourceIntakeId: z.string().nullable() }).nullable().optional(),
  /** Revisions: searches recorded in the collection it started from, kept on republish. */
  inheritedQueries: z.array(z.string()).optional(),
});
export type IntakeSession = z.output<typeof intakeSessionSchema>;

export type IntakeProblemCode =
  | "invalid_case"
  | "not_ready"
  | "collection_exists"
  | "no_draft"
  | "completed"
  | "invalid_field"
  | "duplicate"
  | "too_many"
  | "invalid_image"
  | "unknown_entry"
  | "empty"
  | "changed"
  | "stale"
  | "not_revisable";

export class IntakeProblem extends Error {
  constructor(
    readonly code: IntakeProblemCode,
    message: string,
    readonly field: string | null = null,
  ) {
    super(message);
    this.name = "IntakeProblem";
  }
}

const json = (v: unknown) => `${JSON.stringify(v, null, 2)}\n`;
const sha256 = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");
export const caseDir = (paths: Paths, caseId: string) => join(paths.candidateIntake, caseId);
export const sessionDir = (paths: Paths, caseId: string, intakeId: string) => join(caseDir(paths, caseId), intakeId);
export const sessionFile = (paths: Paths, caseId: string, intakeId: string) => join(sessionDir(paths, caseId, intakeId), "session.json");
export const publishedManifestPath = (paths: Paths, caseId: string) => join(paths.candidates, `${caseId}.json`);

export async function exists(path: string): Promise<boolean> {
  try {
    await readFile(path);
    return true;
  } catch {
    return false;
  }
}

/** The reference must be a genuine, analysed furniture photo whose image still matches its record. */
export async function loadIntakeReference(paths: Paths, caseId: string): Promise<SavedFingerprint> {
  if (!CASE_ID.test(caseId)) throw new IntakeProblem("invalid_case", "Invalid reference");
  let saved: SavedFingerprint;
  try {
    saved = await loadSavedFingerprint(join(paths.predictions, `${caseId}.json`), caseId);
  } catch (error) {
    if (error instanceof SavedRunError) throw new IntakeProblem("not_ready", "This photo has no saved furniture analysis, so products can't be recorded for it yet.");
    throw error;
  }
  try {
    await resolveReferenceImage(paths.imagesMap, saved);
  } catch {
    throw new IntakeProblem("not_ready", "The original photo for this reference is unavailable or changed.");
  }
  return saved;
}

export async function readSession(paths: Paths, caseId: string, intakeId: string): Promise<IntakeSession | null> {
  if (!CASE_ID.test(caseId) || !INTAKE_ID.test(intakeId)) return null;
  try {
    const parsed = intakeSessionSchema.safeParse(JSON.parse(await readFile(sessionFile(paths, caseId, intakeId), "utf8")));
    return parsed.success && parsed.data.caseId === caseId && parsed.data.intakeId === intakeId ? parsed.data : null;
  } catch {
    return null;
  }
}

/** All intake sessions for a reference, newest first. */
export async function listSessions(paths: Paths, caseId: string): Promise<IntakeSession[]> {
  if (!CASE_ID.test(caseId)) return [];
  let names: string[];
  try {
    names = (await readdir(caseDir(paths, caseId))).filter((n) => INTAKE_ID.test(n));
  } catch {
    return [];
  }
  const sessions = (await Promise.all(names.map((n) => readSession(paths, caseId, n)))).filter((s): s is IntakeSession => s !== null);
  return sessions.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
}

export interface IntakeState {
  /** The open draft, if any. */
  draft: IntakeSession | null;
  /** The session that published the current collection, if it came from the web app. */
  completed: IntakeSession | null;
  /** A candidate collection exists for this reference (from this app or another intake path). */
  collectionExists: boolean;
}

export async function getIntakeState(paths: Paths, caseId: string): Promise<IntakeState> {
  const sessions = await listSessions(paths, caseId);
  return {
    draft: sessions.find((s) => s.status === "draft") ?? null,
    completed: sessions.find((s) => s.status === "completed") ?? null,
    collectionExists: CASE_ID.test(caseId) && (await exists(publishedManifestPath(paths, caseId))),
  };
}

/** Opens the existing draft, or creates a new one (exclusive). Refused once a collection exists. */
export async function startIntake(paths: Paths, caseId: string, now = new Date()): Promise<IntakeSession> {
  const saved = await loadIntakeReference(paths, caseId);
  return withCaseLock(paths, caseId, () => createDraft(paths, caseId, saved, now));
}

/** Serializes starting drafts for one reference, so concurrent requests open the same draft. */
export async function withCaseLock<T>(paths: Paths, caseId: string, fn: () => Promise<T>): Promise<T> {
  await mkdir(caseDir(paths, caseId), { recursive: true });
  return withFileLock(join(caseDir(paths, caseId), "drafts"), fn);
}

export const newIntakeId = (now: Date) => `int-${now.toISOString().toLowerCase().replace(/[:.]/g, "-").replace(/-\d{3}z$/, "z")}-${randomUUID().slice(0, 8)}`;

async function createDraft(paths: Paths, caseId: string, saved: SavedFingerprint, now: Date): Promise<IntakeSession> {
  const state = await getIntakeState(paths, caseId);
  if (state.collectionExists) throw new IntakeProblem("collection_exists", "Products have already been added for this photo. The completed collection is kept as it is.");
  if (state.draft) return state.draft;
  const intakeId = newIntakeId(now);
  const at = now.toISOString();
  const session: IntakeSession = intakeSessionSchema.parse({
    recordType: "candidate_intake_session",
    schemaVersion: 1,
    intakeId,
    caseId,
    acquisitionMethod: "operator_assisted",
    referenceImageId: saved.reference.id,
    fingerprintId: saved.fingerprint.id,
    referenceSha256: saved.record.image.sha256,
    status: "draft",
    revision: 0,
    createdAt: at,
    updatedAt: at,
    completedAt: null,
    entries: [],
    published: null,
  });
  await mkdir(caseDir(paths, caseId), { recursive: true });
  await mkdir(sessionDir(paths, caseId, intakeId)); // fails if it exists
  await mkdir(join(sessionDir(paths, caseId, intakeId), "images"));
  if (!(await writeExclusive(sessionFile(paths, caseId, intakeId), json(session)))) throw new IntakeProblem("changed", "The intake was created by another request; reload.");
  return session;
}

/** Runs one change to a draft under its lock, and saves it atomically with a new revision. */
export async function mutateDraft<T>(paths: Paths, caseId: string, intakeId: string, now: Date, change: (s: IntakeSession) => Promise<T>): Promise<{ session: IntakeSession; result: T }> {
  const file = sessionFile(paths, caseId, intakeId);
  return withFileLock(file, async () => {
    const session = await readSession(paths, caseId, intakeId);
    if (!session) throw new IntakeProblem("no_draft", "This product list doesn't exist.");
    if (session.status !== "draft") throw new IntakeProblem("completed", "This product list is complete and can no longer be changed.");
    const result = await change(session);
    const next = intakeSessionSchema.parse({ ...session, revision: session.revision + 1, updatedAt: now.toISOString() });
    await writeReplace(file, json(next));
    return { session: next, result };
  });
}

export interface EntryInput {
  entryId?: string | null;
  listingUrl: string;
  title: string;
  supplierName?: string | null;
  supplierProfileUrl?: string | null;
  priceMin?: string | null;
  priceMax?: string | null;
  currency?: string | null;
  priceUnit?: string | null;
  moqQuantity?: string | null;
  moqUnit?: string | null;
  foundWith?: string | null;
  queryUsed?: string | null;
  notes?: string | null;
  removeImage?: boolean;
}

const clean = (v: string | null | undefined, max: number) => {
  const t = (v ?? "").replace(/\s+/g, " ").trim();
  return t ? t.slice(0, max) : null;
};
const number = (v: string | null | undefined, field: string) => {
  const t = clean(v, 40);
  if (t === null) return null;
  const n = Number(t.replace(/,/g, ""));
  if (!Number.isFinite(n) || n < 0) throw new IntakeProblem("invalid_field", "Enter a number as shown on the listing (no currency symbols).", field);
  return n;
};

/** Validates operator input; returns the fields of an entry (no id, image or timestamps). Never fills in anything. */
export function validateEntryInput(input: EntryInput, dataSource: "live" | "mock" = "live"): Omit<IntakeEntry, "id" | "image" | "createdAt" | "updatedAt"> {
  const listingUrl = clean(input.listingUrl, 2000);
  if (!listingUrl) throw new IntakeProblem("invalid_field", "Paste the Alibaba.com product URL.", "listingUrl");
  const urlProblem = checkMarketplaceUrl(listingUrl, "listing", dataSource);
  if (urlProblem) throw new IntakeProblem("invalid_field", `The product URL ${urlProblem}.`, "listingUrl");
  const title = clean(input.title, 300);
  if (!title) throw new IntakeProblem("invalid_field", "Copy the product title as shown on the listing.", "title");
  const supplierName = clean(input.supplierName, 200);
  const supplierProfileUrl = clean(input.supplierProfileUrl, 2000);
  if (supplierProfileUrl) {
    const problem = checkMarketplaceUrl(supplierProfileUrl, "supplier_profile", dataSource);
    if (problem) throw new IntakeProblem("invalid_field", `The supplier page URL ${problem}.`, "supplierProfileUrl");
    if (!supplierName) throw new IntakeProblem("invalid_field", "Add the supplier name as shown, or leave both supplier fields empty.", "supplierName");
  }
  const min = number(input.priceMin, "priceMin");
  const max = number(input.priceMax, "priceMax");
  const currency = clean(input.currency, 3)?.toUpperCase() ?? null;
  if (currency && !/^[A-Z]{3}$/.test(currency)) throw new IntakeProblem("invalid_field", "Use a three-letter currency code such as USD or INR.", "currency");
  if (min === null && (max !== null || currency)) throw new IntakeProblem("invalid_field", "Enter the lowest listed price, or leave all price fields empty.", "priceMin");
  if (min !== null && max !== null && max < min) throw new IntakeProblem("invalid_field", "The highest price can't be lower than the lowest.", "priceMax");
  const quantityRaw = number(input.moqQuantity, "moqQuantity");
  if (quantityRaw !== null && !Number.isInteger(quantityRaw)) throw new IntakeProblem("invalid_field", "The minimum order must be a whole number.", "moqQuantity");
  if (quantityRaw === 0) throw new IntakeProblem("invalid_field", "The minimum order must be at least 1.", "moqQuantity");
  const foundWith = (input.foundWith ?? "other") as (typeof FOUND_WITH)[number];
  if (!FOUND_WITH.includes(foundWith)) throw new IntakeProblem("invalid_field", "Choose how you found this product.", "foundWith");
  return {
    listingUrl,
    marketplaceProductId: productIdFromListingUrl(listingUrl) ?? null,
    title,
    supplierName,
    supplierProfileUrl,
    price: min === null ? null : { min, max, currency, unit: clean(input.priceUnit, 40) },
    minimumOrder: quantityRaw === null ? null : { quantity: quantityRaw, unit: clean(input.moqUnit, 40) },
    foundWith,
    queryUsed: clean(input.queryUsed, 200),
    notes: clean(input.notes, 1000),
  };
}

/** Checks a product photo exactly like uploads: size, real format, structure, dimensions. */
export function validateProductImage(bytes: Uint8Array) {
  if (bytes.length === 0) throw new IntakeProblem("invalid_image", "The photo file is empty.", "image");
  if (bytes.length > MAX_PRODUCT_IMAGE_BYTES) throw new IntakeProblem("invalid_image", "The photo is larger than 10 MB.", "image");
  try {
    const { mimeType } = validateImageBytes(bytes, MAX_PRODUCT_IMAGE_BYTES);
    const { width, height } = inspectImage(bytes);
    return { mimeType, width, height };
  } catch (error) {
    if (error instanceof ImageInputError) throw new IntakeProblem("invalid_image", /Corrupted/.test(error.message) ? "The photo appears to be corrupted." : "Use a PNG, JPEG or WebP photo of a reasonable size.", "image");
    throw error;
  }
}

/** Adds a product, or updates one when `input.entryId` is given. An image replaces the previous one. */
export async function saveEntry(
  paths: Paths,
  caseId: string,
  intakeId: string,
  input: EntryInput,
  image: { bytes: Uint8Array; name: string | null } | null,
  now = new Date(),
): Promise<{ session: IntakeSession; entry: IntakeEntry }> {
  const saved = await loadIntakeReference(paths, caseId);
  const fields = validateEntryInput(input, saved.fingerprint.source.dataSource);
  const checkedImage = image ? { ...validateProductImage(image.bytes), bytes: image.bytes, name: image.name } : null;
  const dir = sessionDir(paths, caseId, intakeId);
  // Files to remove afterwards: the replaced photo on success, the new photo on failure.
  const removeOnSuccess: string[] = [];
  const removeOnFailure: string[] = [];
  try {
    const { session, result } = await mutateDraft(paths, caseId, intakeId, now, async (s) => {
      const existing = input.entryId ? s.entries.find((e) => e.id === input.entryId) : undefined;
      if (input.entryId && !existing) throw new IntakeProblem("unknown_entry", "That product is no longer in the list.");
      if (!existing && s.entries.length >= MAX_ENTRIES) throw new IntakeProblem("too_many", `A list holds up to ${MAX_ENTRIES} products.`);
      const identity = candidateIdentity(fields);
      const clash = s.entries.find((e) => e.id !== existing?.id && candidateIdentity(e) === identity);
      if (clash) throw new IntakeProblem("duplicate", `This product is already in the list ("${clash.title}").`, "listingUrl");
      const id = existing?.id ?? `p${String(Math.max(0, ...s.entries.map((e) => Number(e.id.slice(1)))) + 1).padStart(2, "0")}`;
      let entryImage = existing?.image ?? null;
      if (input.removeImage) {
        if (entryImage) removeOnSuccess.push(join(dir, entryImage.file));
        entryImage = null;
      }
      if (checkedImage) {
        const file = `images/${id}-${randomUUID().slice(0, 8)}.${EXT[checkedImage.mimeType]}`;
        if (!(await writeExclusive(join(dir, file), checkedImage.bytes))) throw new IntakeProblem("changed", "Could not save the photo; try again.");
        removeOnFailure.push(join(dir, file));
        if (entryImage) removeOnSuccess.push(join(dir, entryImage.file));
        entryImage = { file, sha256: sha256(checkedImage.bytes), mimeType: checkedImage.mimeType, bytes: checkedImage.bytes.length, width: checkedImage.width, height: checkedImage.height, originalName: checkedImage.name ? checkedImage.name.split(/[\\/]/).pop()!.replace(/[^A-Za-z0-9._ -]/g, "_").slice(0, 120) : null };
      }
      const entry: IntakeEntry = intakeEntrySchema.parse({ ...fields, id, image: entryImage, carried: existing?.carried ?? null, createdAt: existing?.createdAt ?? now.toISOString(), updatedAt: now.toISOString() });
      s.entries = existing ? s.entries.map((e) => (e.id === id ? entry : e)) : [...s.entries, entry];
      return entry;
    });
    for (const p of removeOnSuccess) await rm(p, { force: true });
    return { session, entry: result };
  } catch (error) {
    for (const p of removeOnFailure) await rm(p, { force: true });
    throw error;
  }
}

export async function removeEntry(paths: Paths, caseId: string, intakeId: string, entryId: string, now = new Date()): Promise<IntakeSession> {
  let removed: IntakeEntry | undefined;
  const { session } = await mutateDraft(paths, caseId, intakeId, now, async (s) => {
    removed = s.entries.find((e) => e.id === entryId);
    if (!removed) throw new IntakeProblem("unknown_entry", "That product is no longer in the list.");
    s.entries = s.entries.filter((e) => e.id !== entryId);
  });
  const removedImage = removed?.image ? [join(sessionDir(paths, caseId, intakeId), removed.image.file)] : [];
  for (const p of removedImage) await rm(p, { force: true });
  return session;
}

/** Reads one entry's photo for display, confined to the draft folder and hash-checked. */
export async function readEntryImage(paths: Paths, caseId: string, intakeId: string, entryId: string) {
  const session = await readSession(paths, caseId, intakeId);
  const image = session?.entries.find((e) => e.id === entryId)?.image;
  if (!image) return null;
  return readConfined(sessionDir(paths, caseId, intakeId), image.file, image.sha256);
}

/** Builds the standard manifest. Suppliers are merged by profile URL, otherwise by exact name; nothing else is merged. */
export function buildManifest(session: IntakeSession, saved: SavedFingerprint, completedAt: string, imagePath: (e: IntakeEntry) => string): CandidateManifest {
  const suppliers: ManifestSupplier[] = [];
  const supplierRef = new Map<string, string>();
  const candidates: ManifestCandidate[] = session.entries.map((e) => {
    let ref: string | null = null;
    if (e.supplierName) {
      const key = e.supplierProfileUrl ? `url:${canonicalUrl(e.supplierProfileUrl)}` : `name:${e.supplierName.toLowerCase()}`;
      ref = supplierRef.get(key) ?? null;
      if (!ref) {
        ref = `supplier-${suppliers.length + 1}`;
        supplierRef.set(key, ref);
        // Recorded supplier details the form doesn't edit (badges, location…) are kept while name and page are unchanged.
        const carried = e.carried?.supplier;
        const same = carried && carried.name === e.supplierName && (carried.profileUrl ?? null) === (e.supplierProfileUrl ?? null);
        suppliers.push({ ...(same ? carried : {}), ref, name: e.supplierName, profileUrl: e.supplierProfileUrl ?? null } as ManifestSupplier);
      }
    }
    return {
      listingUrl: e.listingUrl,
      marketplaceProductId: e.marketplaceProductId,
      title: e.title,
      ...(e.carried?.category ? { category: e.carried.category } : {}),
      ...(e.carried?.attributes ? { attributes: e.carried.attributes } : {}),
      ...(e.carried?.priceTiers ? { priceTiers: e.carried.priceTiers as ManifestCandidate["priceTiers"] } : {}),
      images: [...(e.image ? [{ localPath: imagePath(e), role: "primary", mimeType: e.image.mimeType }] : []), ...((e.carried?.otherImages ?? []) as ManifestCandidate["images"])],
      price: e.price ? { min: e.price.min, ...(e.price.max !== null ? { max: e.price.max } : {}), ...(e.price.currency ? { currency: e.price.currency } : {}), ...(e.price.unit ? { unit: e.price.unit } : {}) } : null,
      minimumOrder: e.minimumOrder ? { quantity: e.minimumOrder.quantity, ...(e.minimumOrder.unit ? { unit: e.minimumOrder.unit } : {}) } : null,
      supplierRef: ref,
      capturedAt: e.updatedAt,
      foundWith: e.foundWith,
      notes: e.notes,
    };
  });
  return candidateManifestSchema.parse({
    manifestType: "alibaba_candidate_manifest",
    schemaVersion: 1,
    dataSource: saved.fingerprint.source.dataSource,
    caseId: session.caseId,
    referenceImageId: session.referenceImageId,
    fingerprintId: session.fingerprintId,
    capture: {
      status: "completed",
      method: "operator_assisted",
      capturedAt: completedAt,
      tools: [...new Set(session.entries.map((e) => e.foundWith))],
      queriesTyped: [...new Set([...(session.inheritedQueries ?? []), ...session.entries.map((e) => e.queryUsed).filter((q): q is string => Boolean(q))])],
      notes: session.basedOn
        ? `Revision ${session.intakeId} of a collection recorded by hand from Alibaba.com's own website (previous version sha256 ${session.basedOn.manifestSha256}). Nothing was searched or downloaded by the application.`
        : `Recorded by hand in the local web app (candidate intake ${session.intakeId}) from Alibaba.com's own website. Nothing was searched or downloaded by the application.`,
    },
    suppliers,
    candidates,
  });
}

export interface IntakeSummary {
  recordType: "candidate_intake_summary";
  intakeId: string;
  caseId: string;
  acquisitionMethod: "operator_assisted";
  completedAt: string;
  products: number;
  uniqueListings: number;
  suppliers: number;
  withImage: number;
  withoutImage: string[];
  withoutPrice: number;
  withoutMinimumOrder: number;
  withoutSupplier: number;
  eligibleForVisualShortlist: number;
  manifestFile: string;
  manifestSha256: string;
  /** The collection this one replaced (revisions only). */
  previousManifestSha256: string | null;
}

/**
 * Completes a draft (a first collection, or a revision of the published one):
 * re-checks every photo, publishes new photos under new names (published
 * photos are never replaced or deleted, so earlier runs stay readable), writes
 * a complete manifest next to the canonical one, validates it with the same
 * checks and import as source:candidates, and only then moves it into place:
 * exclusively for a first collection, atomically for a revision whose base is
 * still the current collection (otherwise "stale"). Every published version
 * keeps an immutable copy in its intake folder; a failure removes anything
 * this call published and leaves the current collection as it was.
 */
export async function completeIntake(paths: Paths, caseId: string, intakeId: string, now = new Date()): Promise<{ session: IntakeSession; summary: IntakeSummary }> {
  const saved = await loadIntakeReference(paths, caseId);
  const manifestPath = publishedManifestPath(paths, caseId);
  const imagesDir = join(paths.candidates, caseId);
  const display = (p: string) => p.slice(paths.root.length + 1);
  let summary!: IntakeSummary;
  const published: string[] = [];
  let tmp: string | null = null;
  let restore: string | null = null;
  try {
    // One publication per collection at a time; the draft itself is locked inside.
    return await withFileLock(manifestPath, async () => {
      const { session } = await mutateDraft(paths, caseId, intakeId, now, async (s) => {
        if (s.entries.length === 0) throw new IntakeProblem("empty", "Add at least one product first.");
        if (s.fingerprintId !== saved.fingerprint.id || s.referenceSha256 !== saved.record.image.sha256) {
          throw new IntakeProblem("changed", "The photo's saved analysis changed since this list was started.");
        }
        const currentText = await readFile(manifestPath, "utf8").catch(() => null);
        if (s.basedOn) {
          if (currentText === null || sha256(Buffer.from(currentText)) !== s.basedOn.manifestSha256) {
            throw new IntakeProblem("stale", "The saved product list changed after this revision was started. Discard this revision and start a new one.");
          }
          if (!(await exists(join(caseDir(paths, caseId), s.basedOn.snapshotFile)))) throw new IntakeProblem("changed", "The copy of the previous version is missing, so nothing was replaced.");
        } else if (currentText !== null) {
          throw new IntakeProblem("collection_exists", "Products have already been added for this photo. Start a revision to change them.");
        }
        await mkdir(imagesDir, { recursive: true });
        const pathFor = new Map<string, string>();
        for (const e of s.entries) {
          if (!e.image) continue;
          const draftCopy = await readConfined(sessionDir(paths, caseId, intakeId), e.image.file, e.image.sha256);
          if (!draftCopy.ok) throw new IntakeProblem("changed", `The photo for "${e.title}" is missing or changed; replace it before finishing.`);
          // An unchanged photo from the published collection keeps its published file and path.
          if (e.image.publishedPath && (await readConfined(paths.candidates, e.image.publishedPath, e.image.sha256)).ok) {
            pathFor.set(e.id, e.image.publishedPath);
            continue;
          }
          const name = `${s.intakeId}-${e.id}.${EXT[e.image.mimeType]}`;
          const target = join(imagesDir, name);
          // A hard link keeps one copy of the bytes; copy only if linking is unsupported. Both refuse to overwrite.
          await link(join(sessionDir(paths, caseId, intakeId), e.image.file), target).catch(async (error: NodeJS.ErrnoException) => {
            if (error.code === "EEXIST") throw new IntakeProblem("changed", "A product photo with this name already exists in the candidate folder; nothing was replaced.");
            await copyFile(join(sessionDir(paths, caseId, intakeId), e.image!.file), target, 1 /* COPYFILE_EXCL */);
          });
          published.push(target);
          pathFor.set(e.id, `${caseId}/${name}`);
        }
        const completedAt = now.toISOString();
        const manifest = buildManifest(s, saved, completedAt, (e) => pathFor.get(e.id)!);
        const text = json(manifest);

        // Validate a complete copy next to the canonical file (so local paths resolve), with the same
        // checks and import source:candidates and source:auto use, then move it into place.
        tmp = join(paths.candidates, `.${caseId}.${randomUUID()}.tmp`);
        await writeFile(tmp, text, { flag: "wx" });
        const loaded = await loadManifest(tmp, display(manifestPath));
        const problems = await checkManifest(loaded, saved, display(manifestPath), false);
        if (problems.length) throw new IntakeProblem("invalid_field", problems.join("; "));
        importCuratedCandidates([loaded.manifest]);
        if (s.basedOn) {
          restore = currentText;
          await rename(tmp, manifestPath);
        } else {
          await link(tmp, manifestPath).catch((error: NodeJS.ErrnoException) => {
            if (error.code === "EEXIST") throw new IntakeProblem("collection_exists", "Products have already been added for this photo. Start a revision to change them.");
            throw error;
          });
          await rm(tmp, { force: true });
          restore = "";
        }
        tmp = null;

        const withoutImage = s.entries.filter((e) => !e.image).map((e) => e.title);
        summary = {
          recordType: "candidate_intake_summary",
          intakeId: s.intakeId,
          caseId,
          acquisitionMethod: "operator_assisted",
          completedAt,
          products: s.entries.length,
          uniqueListings: new Set(s.entries.map(candidateIdentity)).size,
          suppliers: manifest.suppliers.length,
          withImage: s.entries.length - withoutImage.length,
          withoutImage,
          withoutPrice: s.entries.filter((e) => !e.price).length,
          withoutMinimumOrder: s.entries.filter((e) => !e.minimumOrder).length,
          withoutSupplier: s.entries.filter((e) => !e.supplierName).length,
          eligibleForVisualShortlist: s.entries.length - withoutImage.length,
          manifestFile: display(manifestPath),
          manifestSha256: sha256(Buffer.from(text)),
          previousManifestSha256: s.basedOn?.manifestSha256 ?? null,
        };
        const dir = sessionDir(paths, caseId, intakeId);
        await writeExclusive(join(dir, "manifest.json"), text);
        await writeExclusive(join(dir, "summary.json"), json(summary));
        s.status = "completed";
        s.completedAt = completedAt;
        s.published = { manifestFile: summary.manifestFile, manifestSha256: summary.manifestSha256, imagesDir: display(imagesDir), summaryFile: "summary.json", previousManifestSha256: summary.previousManifestSha256 };
      });
      return { session, summary };
    });
  } catch (error) {
    // Undo only what this call did: new photos, the temporary copy, and (if it was moved in) the canonical file.
    if (tmp) await rm(tmp, { force: true });
    if (restore === "") await rm(manifestPath, { force: true });
    else if (restore !== null) await writeReplace(manifestPath, restore);
    for (const p of published) await rm(p, { force: true });
    throw error;
  }
}
