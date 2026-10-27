import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { z } from "zod";
import { summarizeIssues } from "../../../validation/issues";

/**
 * run.json: the private record of one discovery attempt
 * (evals/local/discovery/<case>/<discovery id>/run.json). It is written
 * before any provider run starts and after every state change, so an
 * interrupted command can be resumed from the provider run id instead of
 * starting (and paying for) another run. It never holds credentials.
 */

export const PROVIDER_RUN_STATES = [
  "planned",
  /** The start request was sent; no answer yet. */
  "start_requested",
  /** The start request failed in a way that does not prove the run was not created. */
  "start_uncertain",
  /** The provider refused to start the run (e.g. 401, 402, 400). Nothing ran. */
  "start_failed",
  "running",
  "succeeded",
  "failed",
  "timed_out",
  "aborted",
] as const;
export type ProviderRunState = (typeof PROVIDER_RUN_STATES)[number];

const iso = z.string().min(1);
const runEntrySchema = z.strictObject({
  mode: z.enum(["image", "keyword"]),
  state: z.enum(PROVIDER_RUN_STATES),
  maxResults: z.int().positive(),
  costCapUsd: z.number().positive(),
  estimatedUsd: z.number().nonnegative(),
  queries: z.array(z.string()),
  providerRunId: z.string().nullable(),
  datasetId: z.string().nullable(),
  startRequestedAt: iso.nullable(),
  startedAt: iso.nullable(),
  finishedAt: iso.nullable(),
  statusMessage: z.string().nullable(),
  chargedEventCounts: z.record(z.string(), z.number()).nullable(),
  usageTotalUsd: z.number().nullable(),
  error: z.strictObject({ category: z.string(), message: z.string() }).nullable(),
  /** Saved provider rows (relative to the run folder). */
  snapshotFile: z.string().nullable(),
  itemCount: z.int().nonnegative().nullable(),
});

export const discoveryRunSchema = z.strictObject({
  recordType: z.literal("marketplace_discovery_run"),
  schemaVersion: z.literal(1),
  discoveryId: z.string().regex(/^disc-[0-9TZ-]+-[0-9a-f]{6}$/),
  caseId: z.string().min(1),
  dataSource: z.enum(["live", "mock"]),
  createdAt: iso,
  updatedAt: iso,
  status: z.enum(["planned", "in_progress", "pending_provider", "completed", "failed"]),
  provider: z.strictObject({
    providerId: z.string().min(1),
    service: z.literal("apify"),
    source: z.string().min(1),
    access: z.literal("third_party_service"),
  }),
  reference: z.strictObject({ referenceImageId: z.string().min(1), fingerprintId: z.string().min(1), sha256: z.string().regex(/^[0-9a-f]{64}$/) }),
  request: z.strictObject({
    mode: z.enum(["image", "keyword", "hybrid"]),
    maxResults: z.int().positive(),
    costCapUsd: z.number().positive(),
    imageTransport: z.strictObject({ kind: z.enum(["url", "apify_storage"]), url: z.string() }).nullable(),
    downloadImages: z.boolean(),
    imagesPerListing: z.int().positive(),
  }),
  runs: z.array(runEntrySchema).min(1),
  storageUpload: z
    .strictObject({ storeId: z.string(), key: z.string(), deletedAt: iso.nullable(), deleteError: z.string().nullable() })
    .nullable(),
  manifestFile: z.string().nullable(),
  summaryFile: z.string().nullable(),
});

export type DiscoveryRunJournal = z.output<typeof discoveryRunSchema>;
export type ProviderRunEntry = DiscoveryRunJournal["runs"][number];

export const TERMINAL_STATES: ReadonlySet<ProviderRunState> = new Set(["start_failed", "succeeded", "failed", "timed_out", "aborted"]);

export function newDiscoveryId(now: Date): string {
  return `disc-${now.toISOString().replace(/[:.]/g, "-").replace(/-\d{3}Z$/, "Z")}-${randomUUID().slice(0, 6)}`;
}

/** Atomic JSON write: temporary file then rename. */
export async function writeJsonAtomic(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.tmp-${process.pid}-${randomUUID().slice(0, 6)}`;
  await writeFile(tmp, `${JSON.stringify(value, null, 2)}\n`, { flag: "wx" });
  await rename(tmp, path);
}

export async function saveJournal(runDir: string, journal: DiscoveryRunJournal): Promise<void> {
  await writeJsonAtomic(join(runDir, "run.json"), discoveryRunSchema.parse(journal));
}

export class JournalError extends Error {}

export async function loadJournal(runDir: string): Promise<DiscoveryRunJournal> {
  let raw: unknown;
  try {
    raw = JSON.parse(await readFile(join(runDir, "run.json"), "utf8"));
  } catch {
    throw new JournalError("No readable run.json in that discovery folder");
  }
  const parsed = discoveryRunSchema.safeParse(raw);
  if (!parsed.success) throw new JournalError(`run.json is invalid: ${summarizeIssues(parsed.error)}`);
  return parsed.data;
}

/** Saved provider rows of one run (bounded; no credentials). */
export const snapshotSchema = z.strictObject({
  recordType: z.literal("provider_response_snapshot"),
  schemaVersion: z.literal(1),
  dataSource: z.enum(["live", "mock"]),
  source: z.string().min(1),
  mode: z.enum(["image", "keyword"]),
  providerRunId: z.string().min(1),
  datasetId: z.string().nullable(),
  finishedAt: iso.nullable(),
  fetchedAt: iso,
  itemLimit: z.int().positive(),
  truncated: z.boolean(),
  items: z.array(z.unknown()),
});
export type ProviderSnapshot = z.output<typeof snapshotSchema>;

export async function loadSnapshot(path: string): Promise<ProviderSnapshot> {
  let raw: unknown;
  try {
    raw = JSON.parse(await readFile(path, "utf8"));
  } catch {
    throw new JournalError(`Provider snapshot ${path.split("/").pop()} cannot be read or is not JSON`);
  }
  const parsed = snapshotSchema.safeParse(raw);
  if (!parsed.success) throw new JournalError(`Provider snapshot is invalid: ${summarizeIssues(parsed.error)}`);
  return parsed.data;
}
