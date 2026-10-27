import { z } from "zod";
import { summarizeIssues } from "../validation/issues";

/**
 * JSON protocol between the shortlist command and the local Python embedding
 * component (services/vision, `python -m vfsa_vision embed`). Requests go on
 * stdin; one JSON document comes back on stdout. Responses are validated
 * strictly and cross-checked against the request before any score is used.
 */

export const PROTOCOL = "vfsa-image-similarity";
export const PROTOCOL_VERSION = 1;
export const DEFAULT_MODEL_ID = "google/siglip2-base-patch16-384";
export const MODEL_ID_PATTERN = /^google\/siglip2-[a-z0-9][a-z0-9.-]*$/;
export const DEVICES = ["auto", "mps", "cpu"] as const;
export type DeviceRequest = (typeof DEVICES)[number];
/** Normalized vectors can give a dot product slightly outside [-1, 1]. */
export const COSINE_TOLERANCE = 1e-4;

export interface EmbedImageSpec {
  ref: string;
  path: string;
  sha256: string;
}

export interface EmbedRequest {
  protocol: typeof PROTOCOL;
  protocolVersion: typeof PROTOCOL_VERSION;
  model: { id: string; revision: string | null };
  device: DeviceRequest;
  reference: { id: string; path: string; sha256: string };
  /** One group per listing; images in selection-priority order. */
  groups: { id: string; images: EmbedImageSpec[] }[];
}

const sha256 = z.string().regex(/^[0-9a-f]{64}$/);
const commit = z.string().regex(/^[0-9a-f]{40}$/);
const finite = z.number().refine(Number.isFinite, "must be finite");

const rejectedImageSchema = z.strictObject({ ref: z.string().min(1), problem: z.string().min(1), message: z.string() });
const imageInfoSchema = {
  sha256,
  format: z.enum(["PNG", "JPEG", "WEBP", "AVIF"]),
  width: z.int().positive(),
  height: z.int().positive(),
  sourceMode: z.string().min(1),
};

const embeddedGroupSchema = z.strictObject({
  id: z.string().min(1),
  status: z.literal("embedded"),
  selectedImage: z.strictObject({ ref: z.string().min(1), ...imageInfoSchema }),
  embeddingCosineSimilarity: finite.refine((v) => Math.abs(v) <= 1 + COSINE_TOLERANCE, "must be a cosine in [-1, 1]"),
  rejectedImages: z.array(rejectedImageSchema),
});
const unusableGroupSchema = z.strictObject({
  id: z.string().min(1),
  status: z.literal("no_usable_image"),
  rejectedImages: z.array(rejectedImageSchema).min(1),
});

export const embedOkResponseSchema = z.strictObject({
  protocol: z.literal(PROTOCOL),
  protocolVersion: z.literal(PROTOCOL_VERSION),
  status: z.literal("ok"),
  model: z.strictObject({
    id: z.string().regex(MODEL_ID_PATTERN),
    revision: commit,
    architecture: z.string().min(1),
    modelType: z.enum(["siglip", "siglip2"]),
    embeddingDim: z.int().positive(),
    featureSource: z.string().min(1),
    dtype: z.literal("float32"),
  }),
  device: z.strictObject({ type: z.enum(["mps", "cpu"]), requested: z.enum(DEVICES), reason: z.string().min(1) }),
  preprocessing: z.record(z.string(), z.unknown()),
  runtime: z.record(z.string(), z.string()),
  reference: z.strictObject({ id: z.string().min(1), ...imageInfoSchema }),
  groups: z.array(z.discriminatedUnion("status", [embeddedGroupSchema, unusableGroupSchema])),
});

export const embedErrorResponseSchema = z.strictObject({
  protocol: z.literal(PROTOCOL),
  protocolVersion: z.literal(PROTOCOL_VERSION),
  status: z.literal("error"),
  error: z.looseObject({ code: z.string().min(1), message: z.string() }),
});

export type EmbedOkResponse = z.output<typeof embedOkResponseSchema>;
export type EmbeddedGroup = z.output<typeof embeddedGroupSchema>;
export type UnusableGroup = z.output<typeof unusableGroupSchema>;

export const environmentResponseSchema = z.looseObject({
  status: z.literal("ok"),
  runtime: z.record(z.string(), z.string()),
  imageFormats: z.record(z.string(), z.boolean()),
  device: z.looseObject({ auto: z.string(), reason: z.string() }),
  model: z.looseObject({ id: z.string(), cached: z.boolean(), revision: z.string().nullable(), reason: z.string().optional() }),
});
export type EnvironmentResponse = z.output<typeof environmentResponseSchema>;

/** The Python component answered, but not in a way that can be trusted. */
export class EmbeddingProtocolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EmbeddingProtocolError";
  }
}

/** The Python component reported a failure (bad image, model not cached, ...). */
export class EmbeddingServiceError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly exitCode: number | null,
  ) {
    super(message);
    this.name = "EmbeddingServiceError";
  }
}

/**
 * Validates a response and cross-checks it against the request: same model,
 * same reference, exactly the requested groups, selected images that were
 * offered with the hashes offered, and the documented ordering.
 */
export function validateEmbedResponse(request: EmbedRequest, raw: unknown): EmbedOkResponse {
  const parsed = embedOkResponseSchema.safeParse(raw);
  if (!parsed.success) throw new EmbeddingProtocolError(`Embedding response is invalid: ${summarizeIssues(parsed.error)}`);
  const res = parsed.data;
  const fail = (message: string): never => {
    throw new EmbeddingProtocolError(`Embedding response is inconsistent with the request: ${message}`);
  };

  if (res.model.id !== request.model.id) fail(`model "${res.model.id}" was not the requested "${request.model.id}"`);
  const pinned = request.model.revision;
  if (pinned && /^[0-9a-f]{40}$/.test(pinned) && res.model.revision !== pinned) fail("model revision differs from the pinned revision");
  if (request.device !== "auto" && res.device.type !== request.device) fail(`device "${res.device.type}" was not the requested "${request.device}"`);
  if (res.device.requested !== request.device) fail("requested device was not echoed correctly");
  if (res.reference.id !== request.reference.id || res.reference.sha256 !== request.reference.sha256) fail("reference image differs");

  const requested = new Map(request.groups.map((g) => [g.id, g]));
  const seen = new Set<string>();
  for (const g of res.groups) {
    const spec = requested.get(g.id);
    if (!spec) fail(`unknown group "${g.id}"`);
    if (seen.has(g.id)) fail(`group "${g.id}" appears twice`);
    seen.add(g.id);
    const offered = new Map(spec!.images.map((i) => [i.ref, i]));
    for (const r of g.rejectedImages) if (!offered.has(r.ref)) fail(`group "${g.id}" rejected an image that was not offered`);
    if (g.status === "embedded") {
      const image = offered.get(g.selectedImage.ref);
      if (!image) fail(`group "${g.id}" selected an image that was not offered`);
      if (image!.sha256 !== g.selectedImage.sha256) fail(`group "${g.id}" selected image hash differs`);
      // The selected image must be the first offered image that was not rejected.
      const rejected = new Set(g.rejectedImages.map((r) => r.ref));
      const firstUsable = spec!.images.find((i) => !rejected.has(i.ref));
      if (firstUsable?.ref !== g.selectedImage.ref) fail(`group "${g.id}" did not follow the image-selection order`);
    } else if (g.rejectedImages.length !== spec!.images.length) {
      fail(`group "${g.id}" is unusable but not every image was rejected`);
    }
  }
  if (seen.size !== requested.size) fail("some requested groups are missing");

  // Embedded groups first, by descending cosine then ascending id; then unusable groups by id.
  let previous: EmbeddedGroup | undefined;
  let unusableStarted = false;
  let previousUnusable: string | undefined;
  for (const g of res.groups) {
    if (g.status === "embedded") {
      if (unusableStarted) fail("embedded groups must come before unusable ones");
      if (previous) {
        const a = previous.embeddingCosineSimilarity;
        const b = g.embeddingCosineSimilarity;
        if (b > a || (b === a && g.id < previous.id)) fail("groups are not in descending similarity order");
      }
      previous = g;
    } else {
      if (previousUnusable !== undefined && g.id < previousUnusable) fail("unusable groups are not ordered by id");
      unusableStarted = true;
      previousUnusable = g.id;
    }
  }
  return res;
}
