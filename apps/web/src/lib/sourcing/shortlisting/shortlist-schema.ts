import { readFile } from "node:fs/promises";
import { z } from "zod";
import { summarizeIssues } from "../validation/issues";

/**
 * Reader for saved shortlist reports (`shortlist:images`). Validates the
 * fields other stages rely on; fields it does not use are accepted as written.
 */

const sha256 = z.string().regex(/^[0-9a-f]{64}$/);
const entrySchema = z.looseObject({
  rank: z.int().positive(),
  listingId: z.string().min(1),
  image: z.looseObject({ ref: z.string().min(1), sha256 }),
  embeddingCosineSimilarity: z.number().min(-1.0001).max(1.0001),
  visualVerificationStatus: z.literal("not_assessed"),
});

export const savedShortlistSchema = z.looseObject({
  recordType: z.literal("visual_shortlist"),
  schemaVersion: z.literal(1),
  caseId: z.string().min(1),
  createdAt: z.string().min(1),
  synthetic: z.boolean(),
  model: z.looseObject({ id: z.string().min(1), revision: z.string().min(1) }).nullable(),
  reference: z.looseObject({ referenceImageId: z.string().min(1), fingerprintId: z.string().min(1), sha256 }),
  shortlist: z.array(entrySchema),
  belowTopK: z.array(z.string()),
  excluded: z.array(z.looseObject({ listingId: z.string().min(1), reason: z.string().min(1) })),
});

export type SavedShortlist = z.output<typeof savedShortlistSchema>;

export class ShortlistFileError extends Error {
  constructor(
    readonly missing: boolean,
    message: string,
  ) {
    super(message);
    this.name = "ShortlistFileError";
  }
}

export async function loadSavedShortlist(path: string, label: string): Promise<SavedShortlist> {
  let raw: unknown;
  try {
    raw = JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    const missing = (error as NodeJS.ErrnoException).code === "ENOENT";
    throw new ShortlistFileError(missing, missing ? `No shortlist at ${label}` : `Shortlist ${label} cannot be read or is not valid JSON`);
  }
  const parsed = savedShortlistSchema.safeParse(raw);
  if (!parsed.success) throw new ShortlistFileError(false, `Shortlist ${label} is invalid: ${summarizeIssues(parsed.error)}`);
  const ranks = parsed.data.shortlist.map((e) => e.rank);
  if (ranks.some((r, i) => r !== i + 1)) throw new ShortlistFileError(false, `Shortlist ${label} has non-consecutive ranks`);
  return parsed.data;
}
