import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { candidateIdentity, candidateManifestSchema, type CandidateManifest } from "../../discovery/curated/manifest";
import { writeExclusive } from "../analysis/attempts";
import { CASE_ID, type Paths } from "../data";
import { readConfined } from "../evidence";
import {
  caseDir,
  ENTRY_ID,
  FOUND_WITH,
  getIntakeState,
  IntakeProblem,
  intakeSessionSchema,
  loadIntakeReference,
  mutateDraft,
  newIntakeId,
  publishedManifestPath,
  readSession,
  sessionDir,
  sessionFile,
  validateProductImage,
  withCaseLock,
  type IntakeEntry,
  type IntakeSession,
} from "./intake";

/**
 * Revisions of a published candidate collection. A revision is a new draft
 * pre-filled from the current collection; the operator can attach or replace
 * product photos, correct optional details or add products, review the
 * changes, and publish. The collection it started from is kept: an immutable
 * snapshot in candidate-intake/<case>/history/, the previous intake's own
 * copy, and every published photo file (earlier runs keep reading them).
 * Publishing is refused if the collection changed after the revision began.
 */

const sha256 = (b: Uint8Array | string) => createHash("sha256").update(b).digest("hex");
const EXT = { "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp" } as const;

export interface CollectionProduct {
  index: number;
  title: string;
  listingUrl: string;
  marketplaceProductId: string | null;
  supplierName: string | null;
  price: CandidateManifest["candidates"][number]["price"];
  minimumOrder: CandidateManifest["candidates"][number]["minimumOrder"];
  /** Path (relative to the candidates folder) of the photo used for comparison, when one exists locally. */
  photo: string | null;
}

export interface Collection {
  sha256: string;
  manifest: CandidateManifest;
  revisable: boolean;
  products: CollectionProduct[];
  withPhoto: number;
}

const primaryLocalPath = (c: CandidateManifest["candidates"][number]) => {
  const local = c.images.filter((i): i is Extract<typeof i, { localPath: string }> => "localPath" in i);
  return (local.find((i) => i.role === "primary") ?? local[0])?.localPath ?? null;
};

/** The current published collection for a reference, read and validated (null when there is none or it is unreadable). */
export async function readCollection(paths: Paths, caseId: string): Promise<Collection | null> {
  if (!CASE_ID.test(caseId)) return null;
  let text: string;
  try {
    text = await readFile(publishedManifestPath(paths, caseId), "utf8");
  } catch {
    return null;
  }
  let manifest: CandidateManifest;
  try {
    manifest = candidateManifestSchema.parse(JSON.parse(text));
  } catch {
    return null;
  }
  const suppliers = new Map(manifest.suppliers.map((s) => [s.ref, s]));
  const products: CollectionProduct[] = [];
  for (const [index, c] of manifest.candidates.entries()) {
    const local = primaryLocalPath(c);
    const photo = local && (await readConfined(paths.candidates, local, null)).ok ? local : null;
    products.push({
      index,
      title: c.title,
      listingUrl: c.listingUrl,
      marketplaceProductId: c.marketplaceProductId ?? null,
      supplierName: (c.supplierRef && suppliers.get(c.supplierRef)?.name) || null,
      price: c.price ?? null,
      minimumOrder: c.minimumOrder ?? null,
      photo,
    });
  }
  return { sha256: sha256(text), manifest, revisable: manifest.capture.method === "operator_assisted" && manifest.dataSource === "live", products, withPhoto: products.filter((p) => p.photo).length };
}

/** One published product photo for display, confined to the candidates folder. */
export async function readCollectionImage(paths: Paths, caseId: string, index: number) {
  const collection = await readCollection(paths, caseId);
  const photo = collection?.products[index]?.photo;
  return photo ? readConfined(paths.candidates, photo, null) : null;
}

/**
 * Opens a revision of the current collection (or returns the open draft).
 * Products, fields and photos are copied in as they are; nothing is fetched.
 */
export async function startRevision(paths: Paths, caseId: string, now = new Date()): Promise<IntakeSession> {
  const saved = await loadIntakeReference(paths, caseId);
  return withCaseLock(paths, caseId, async () => {
    const state = await getIntakeState(paths, caseId);
    if (state.draft) return state.draft;
    const text = await readFile(publishedManifestPath(paths, caseId), "utf8").catch(() => null);
    if (text === null) throw new IntakeProblem("no_draft", "There is no saved product list to revise yet.");
    const collection = await readCollection(paths, caseId);
    if (!collection) throw new IntakeProblem("changed", "The saved product list can't be read, so it can't be revised here.");
    if (!collection.revisable) throw new IntakeProblem("not_revisable", "This product list wasn't recorded by hand, so it can't be revised here.");
    const m = collection.manifest;
    if (m.candidates.length > 20) throw new IntakeProblem("too_many", "This product list is too long to revise here.");
    if (m.fingerprintId !== saved.fingerprint.id) throw new IntakeProblem("changed", "The saved product list belongs to an earlier analysis of this photo.");

    // Immutable snapshot of exactly what is being revised (kept even if the revision is discarded).
    const historyDir = join(caseDir(paths, caseId), "history");
    await mkdir(historyDir, { recursive: true });
    const snapshotFile = `history/manifest-${collection.sha256}.json`;
    await writeExclusive(join(caseDir(paths, caseId), snapshotFile), text);

    const intakeId = newIntakeId(now);
    const dir = sessionDir(paths, caseId, intakeId);
    await mkdir(dir);
    await mkdir(join(dir, "images"));
    const suppliers = new Map(m.suppliers.map((s) => [s.ref, s]));
    const entries: IntakeEntry[] = [];
    for (const [i, c] of m.candidates.entries()) {
      const id = `p${String(i + 1).padStart(2, "0")}`;
      if (!ENTRY_ID.test(id)) throw new IntakeProblem("too_many", "This product list is too long to revise here.");
      const local = primaryLocalPath(c);
      let image: IntakeEntry["image"] = null;
      if (local) {
        const read = await readConfined(paths.candidates, local, null);
        if (read.ok) {
          const { mimeType, width, height } = validateProductImage(read.bytes);
          const file = `images/${id}-${randomUUID().slice(0, 8)}.${EXT[mimeType]}`;
          // A draft copy of the checked bytes; the published file is never moved or changed.
          if (!(await writeExclusive(join(dir, file), read.bytes))) throw new IntakeProblem("changed", "Could not copy a saved photo into the revision; try again.");
          image = { file, sha256: sha256(read.bytes), mimeType, bytes: read.bytes.length, width, height, originalName: null, publishedPath: local };
        }
      }
      const supplier = c.supplierRef ? suppliers.get(c.supplierRef) : undefined;
      const capturedAt = c.capturedAt ?? m.capture.capturedAt ?? now.toISOString();
      entries.push({
        id,
        listingUrl: c.listingUrl,
        marketplaceProductId: c.marketplaceProductId ?? null,
        title: c.title,
        supplierName: supplier?.name ?? null,
        supplierProfileUrl: supplier?.profileUrl ?? null,
        price: c.price ? { min: c.price.min, max: c.price.max ?? null, currency: c.price.currency ?? null, unit: c.price.unit ?? null } : null,
        minimumOrder: c.minimumOrder ? { quantity: c.minimumOrder.quantity, unit: c.minimumOrder.unit ?? null } : null,
        foundWith: (FOUND_WITH as readonly string[]).includes(c.foundWith ?? "") ? (c.foundWith as IntakeEntry["foundWith"]) : "other",
        queryUsed: null,
        notes: c.notes ?? null,
        image,
        carried: {
          category: c.category ?? null,
          attributes: c.attributes ?? null,
          priceTiers: c.priceTiers ?? null,
          otherImages: c.images.filter((img) => !("localPath" in img) || img.localPath !== local),
          supplier: supplier ? (supplier as Record<string, unknown>) : null,
        },
        createdAt: capturedAt,
        updatedAt: capturedAt,
      });
    }
    const sourceIntakeId = state.completed?.published?.manifestSha256 === collection.sha256 ? state.completed.intakeId : null;
    const at = now.toISOString();
    const session = intakeSessionSchema.parse({
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
      entries,
      published: null,
      basedOn: { manifestSha256: collection.sha256, snapshotFile, sourceIntakeId },
      inheritedQueries: m.capture.queriesTyped,
    });
    if (!(await writeExclusive(sessionFile(paths, caseId, intakeId), `${JSON.stringify(session, null, 2)}\n`))) {
      throw new IntakeProblem("changed", "The revision was created by another request; reload.");
    }
    return session;
  });
}

/** Attaches or replaces the photo of one recorded product, without touching its other details. */
export async function setEntryImage(paths: Paths, caseId: string, intakeId: string, entryId: string, image: { bytes: Uint8Array; name: string | null }, now = new Date()) {
  const checked = validateProductImage(image.bytes);
  const dir = sessionDir(paths, caseId, intakeId);
  const file = `images/${entryId}-${randomUUID().slice(0, 8)}.${EXT[checked.mimeType]}`;
  if (!ENTRY_ID.test(entryId)) throw new IntakeProblem("unknown_entry", "That product is no longer in the list.");
  const removeOnSuccess: string[] = [];
  const removeOnFailure: string[] = [];
  try {
    const { session } = await mutateDraft(paths, caseId, intakeId, now, async (s) => {
      const entry = s.entries.find((e) => e.id === entryId);
      if (!entry) throw new IntakeProblem("unknown_entry", "That product is no longer in the list.");
      if (!(await writeExclusive(join(dir, file), image.bytes))) throw new IntakeProblem("changed", "Could not save the photo; try again.");
      removeOnFailure.push(join(dir, file));
      // Only the draft's own copy is removed; a published photo file is never touched.
      if (entry.image) removeOnSuccess.push(join(dir, entry.image.file));
      const name = image.name ? image.name.split(/[\\/]/).pop()!.replace(/[^A-Za-z0-9._ -]/g, "_").slice(0, 120) : null;
      entry.image = { file, sha256: sha256(image.bytes), mimeType: checked.mimeType, bytes: image.bytes.length, width: checked.width, height: checked.height, originalName: name, publishedPath: null };
      entry.updatedAt = now.toISOString();
    });
    for (const p of removeOnSuccess) await rm(p, { force: true });
    return session;
  } catch (error) {
    for (const p of removeOnFailure) await rm(p, { force: true });
    throw error;
  }
}

/** Closes a draft without publishing it. Its files are kept; the published collection is unaffected. */
export async function discardDraft(paths: Paths, caseId: string, intakeId: string, now = new Date()) {
  const { session } = await mutateDraft(paths, caseId, intakeId, now, async (s) => {
    s.status = "discarded";
  });
  return session;
}

export interface RevisionChanges {
  photosAdded: number;
  photosReplaced: number;
  productsAdded: number;
  productsRemoved: number;
  detailsChanged: number;
  unchanged: number;
}

/** What publishing this revision would change, compared with the snapshot it started from. */
export async function describeRevision(paths: Paths, session: IntakeSession): Promise<RevisionChanges | null> {
  if (!session.basedOn) return null;
  let base: CandidateManifest;
  try {
    base = candidateManifestSchema.parse(JSON.parse(await readFile(join(caseDir(paths, session.caseId), session.basedOn.snapshotFile), "utf8")));
  } catch {
    return null;
  }
  const suppliers = new Map(base.suppliers.map((s) => [s.ref, s]));
  const baseByIdentity = new Map(base.candidates.map((c) => [candidateIdentity(c), c]));
  const changes: RevisionChanges = { photosAdded: 0, photosReplaced: 0, productsAdded: 0, productsRemoved: 0, detailsChanged: 0, unchanged: 0 };
  const seen = new Set<string>();
  for (const e of session.entries) {
    const identity = candidateIdentity(e);
    const b = baseByIdentity.get(identity);
    if (!b) {
      changes.productsAdded++;
      continue;
    }
    seen.add(identity);
    const basePhoto = primaryLocalPath(b);
    let changed = false;
    if (e.image && !basePhoto) {
      changes.photosAdded++;
      changed = true;
    } else if (e.image && e.image.publishedPath !== basePhoto) {
      changes.photosReplaced++;
      changed = true;
    }
    const s = b.supplierRef ? suppliers.get(b.supplierRef) : undefined;
    const details = [b.title !== e.title, (s?.name ?? null) !== e.supplierName, (s?.profileUrl ?? null) !== e.supplierProfileUrl, JSON.stringify(b.price ?? null) !== JSON.stringify(e.price ? Object.fromEntries(Object.entries(e.price).filter(([, v]) => v !== null)) : null), JSON.stringify(b.minimumOrder ?? null) !== JSON.stringify(e.minimumOrder ? Object.fromEntries(Object.entries(e.minimumOrder).filter(([, v]) => v !== null)) : null), (b.notes ?? null) !== e.notes];
    if (details.some(Boolean)) {
      changes.detailsChanged++;
      changed = true;
    }
    if (!changed) changes.unchanged++;
  }
  changes.productsRemoved = [...baseByIdentity.keys()].filter((k) => !seen.has(k)).length;
  return changes;
}

export async function readDraft(paths: Paths, caseId: string, intakeId: string) {
  const s = await readSession(paths, caseId, intakeId);
  return s?.status === "draft" ? s : null;
}
