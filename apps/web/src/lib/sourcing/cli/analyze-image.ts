import { basename, resolve } from "node:path";
import { parseArgs } from "node:util";
import type { FurnitureFeature, FurnitureFingerprint } from "../domain";
import { formatBytes, ImageInputError, type ReferenceImageContentProvider } from "../image-input/image-content";
import {
  createLocalReferenceImage,
  InMemoryImageContentProvider,
  readLocalImageFile,
} from "../image-input/local-file";
import { readImageUnderstandingConfig, type ImageUnderstandingConfig } from "../understanding/openai/config";
import { FurnitureNotIdentifiedError, VisionModelError } from "../understanding/openai/errors";
import { FURNITURE_UNDERSTANDING_INSTRUCTIONS_VERSION } from "../understanding/openai/instructions";
import {
  OpenAIImageUnderstandingService,
  type ImageUnderstandingDetails,
} from "../understanding/openai/openai-image-understanding";
import { DEFAULT_VISION_REQUEST_SETTINGS, OpenAIVisionClient } from "../understanding/openai/vision-client";

export const EXIT_OK = 0;
export const EXIT_ANALYSIS_FAILED = 1;
export const EXIT_USAGE = 2;

export interface CliIO {
  out(line: string): void;
  err(line: string): void;
}

export interface AnalyzeImageService {
  analyzeWithDetails: OpenAIImageUnderstandingService["analyzeWithDetails"];
}

export interface AnalyzeImageCliDeps {
  env: Record<string, string | undefined>;
  io: CliIO;
  /** Directory relative --file paths are resolved against. */
  cwd: string;
  now?: () => Date;
  /** Only called in --live mode with an API key present. */
  createService?: (
    config: Required<ImageUnderstandingConfig>,
    images: ReferenceImageContentProvider,
  ) => AnalyzeImageService;
}

export const USAGE = `Analyse one local furniture photograph with the configured OpenAI model.

Usage:
  pnpm analyze:image --file <path> [--live] [--json]

Options:
  -f, --file <path>  JPEG, PNG or WebP image, at most ${formatBytes(10 * 1024 * 1024)}
      --live         Send ONE paid request to OpenAI. Without it, nothing is sent (dry run).
      --json         Print the result as JSON
  -h, --help         Show this help

Configuration (apps/web/.env.local):
  OPENAI_API_KEY                     required for --live
  OPENAI_IMAGE_UNDERSTANDING_MODEL   default gpt-6-luna`;

const defaultCreateService: NonNullable<AnalyzeImageCliDeps["createService"]> = (config, images) =>
  new OpenAIImageUnderstandingService({
    images,
    vision: OpenAIVisionClient.fromApiKey(config.apiKey, config.model),
  });

export async function runAnalyzeImageCli(argv: string[], deps: AnalyzeImageCliDeps): Promise<number> {
  const { io } = deps;

  let args: { file?: string; live?: boolean; json?: boolean; help?: boolean };
  try {
    // pnpm may forward a literal "--" separator; it carries no meaning here.
    ({ values: args } = parseArgs({
      args: argv.filter((arg) => arg !== "--"),
      options: {
        file: { type: "string", short: "f" },
        live: { type: "boolean", default: false },
        json: { type: "boolean", default: false },
        help: { type: "boolean", short: "h", default: false },
      },
      strict: true,
      allowPositionals: false,
    }));
  } catch (error) {
    io.err(`Error: ${(error as Error).message}`);
    io.err(USAGE);
    return EXIT_USAGE;
  }

  if (args.help) {
    io.out(USAGE);
    return EXIT_OK;
  }
  if (!args.file) {
    io.err("Error: --file <path> is required");
    io.err(USAGE);
    return EXIT_USAGE;
  }

  const config = readImageUnderstandingConfig(deps.env);
  const now = deps.now ?? (() => new Date());

  let content;
  try {
    content = await readLocalImageFile(resolve(deps.cwd, args.file));
  } catch (error) {
    if (error instanceof ImageInputError) {
      io.err(`Image input error (${error.code}): ${error.message} [${basename(args.file)}]`);
      return EXIT_USAGE;
    }
    throw error;
  }

  const reference = createLocalReferenceImage(content, now().toISOString());
  const settings = { ...DEFAULT_VISION_REQUEST_SETTINGS, model: config.model };

  if (!args.live) {
    const lines = [
      "DRY RUN: no request was sent to OpenAI.",
      `Image:            ${basename(args.file)} (${content.mimeType}, ${formatBytes(content.bytes.length)})`,
      `Reference id:     ${reference.id}`,
      `Model:            ${settings.model}`,
      `Request:          Responses API, Structured Outputs, image detail "${settings.imageDetail}",`,
      `                  reasoning "${settings.reasoningEffort}", max ${settings.maxOutputTokens} output tokens,`,
      `                  timeout ${settings.timeoutMs / 1000}s, retries 0, store false, no tools`,
      `Instructions:     version ${FURNITURE_UNDERSTANDING_INSTRUCTIONS_VERSION}`,
      `OPENAI_API_KEY:   ${config.apiKey ? "set" : "NOT SET (required for --live)"}`,
      "Run again with --live to send one paid request.",
    ];
    if (args.json) {
      io.out(JSON.stringify({ dryRun: true, referenceId: reference.id, mimeType: content.mimeType, bytes: content.bytes.length, settings, apiKeySet: Boolean(config.apiKey) }, null, 2));
    } else {
      lines.forEach((line) => io.out(line));
    }
    return EXIT_OK;
  }

  if (!config.apiKey) {
    io.err("Error: OPENAI_API_KEY is not set. Add it to apps/web/.env.local (see .env.example).");
    return EXIT_USAGE;
  }

  const images = new InMemoryImageContentProvider();
  images.register(reference.id, content);
  const service = (deps.createService ?? defaultCreateService)(
    { apiKey: config.apiKey, model: config.model },
    images,
  );

  try {
    const details = await service.analyzeWithDetails(reference);
    if (args.json) {
      io.out(JSON.stringify({ referenceId: reference.id, responseId: details.responseId, usage: details.usage ?? null, fingerprint: details.fingerprint }, null, 2));
    } else {
      formatAnalysis(details).forEach((line) => io.out(line));
    }
    return EXIT_OK;
  } catch (error) {
    reportFailure(error, io);
    return EXIT_ANALYSIS_FAILED;
  }
}

function reportFailure(error: unknown, io: CliIO): void {
  if (error instanceof FurnitureNotIdentifiedError) {
    io.err(`No fingerprint produced: the model reported "${error.outcome}".`);
    if (error.modelReason) io.err(`Model's reason (untrusted): ${error.modelReason}`);
    return;
  }
  if (error instanceof VisionModelError) {
    io.err(`Image analysis failed [${error.category}]: ${error.message}`);
    if (error.requestId) io.err(`OpenAI request id: ${error.requestId}`);
    return;
  }
  io.err(`Image analysis failed: ${error instanceof Error ? error.name : "unknown error"}`);
}

const describe = (f: FurnitureFeature) =>
  f.certainty === "unknown"
    ? `${f.attribute}${f.rationale ? ` (${f.rationale})` : ""}`
    : `${f.attribute}: ${f.value}${f.certainty === "inferred" && f.rationale ? ` (${f.rationale})` : ""}`;

function featureLines(title: string, features: FurnitureFeature[]): string[] {
  return [title, ...(features.length ? features.map((f) => `  - ${describe(f)}`) : ["  (none)"])];
}

/** Human-readable summary. Never includes image data or provider payloads. */
export function formatAnalysis(details: ImageUnderstandingDetails): string[] {
  const fp: FurnitureFingerprint = details.fingerprint;
  const byCertainty = (c: FurnitureFeature["certainty"]) => (features: FurnitureFeature[]) =>
    features.filter((f) => f.certainty === c);
  const observed = byCertainty("observed");
  const all = [...fp.structure, ...fp.appearance, ...fp.distinctiveFeatures];
  const usage = details.usage;

  return [
    "LIVE IMAGE ANALYSIS (model output, unverified)",
    `Reference id:   ${fp.referenceImageIds.join(", ")}`,
    `Model:          ${fp.source.modelId ?? "unknown"}`,
    `Category:       ${fp.category}${fp.subtype ? ` / ${fp.subtype}` : ""}`,
    ...featureLines("Structure (observed):", observed(fp.structure)),
    ...featureLines("Appearance (observed):", observed(fp.appearance)),
    ...featureLines("Distinctive features (observed):", observed(fp.distinctiveFeatures)),
    ...featureLines("Inferred (not verified):", byCertainty("inferred")(all)),
    ...featureLines("Unknown:", byCertainty("unknown")(all)),
    "Search queries:",
    ...(fp.searchQueries.length ? fp.searchQueries.map((q) => `  - ${q}`) : ["  (none)"]),
    `Provenance:     kind=${fp.source.kind}, dataSource=${fp.source.dataSource}, fingerprint=${fp.id}, created=${fp.createdAt}`,
    usage
      ? `Token usage:    input ${usage.inputTokens}, output ${usage.outputTokens}${usage.reasoningTokens !== undefined ? ` (reasoning ${usage.reasoningTokens})` : ""}, total ${usage.totalTokens}`
      : "Token usage:    not reported",
    `Response id:    ${details.responseId}`,
  ];
}
