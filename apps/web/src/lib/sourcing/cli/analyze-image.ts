import { access, constants, mkdir, stat, writeFile } from "node:fs/promises";
import { basename, dirname, extname, resolve } from "node:path";
import { parseArgs } from "node:util";
import type { FurnitureFeature, FurnitureFingerprint } from "../domain";
import { buildRunRecord, type RunOutcome } from "../evaluation/run-record";
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
  /** Monotonic milliseconds, for request duration. */
  clock?: () => number;
  /** Only called in --live mode with an API key present. */
  createService?: (
    config: Required<ImageUnderstandingConfig>,
    images: ReferenceImageContentProvider,
  ) => AnalyzeImageService;
}

export const USAGE = `Analyse one local furniture photograph with the configured OpenAI model.

Usage:
  pnpm analyze:image --file <path> [--live] [--json] [--case <id>] [--output <file.json>]

Options:
  -f, --file <path>     JPEG, PNG or WebP image, at most ${formatBytes(10 * 1024 * 1024)}
      --live            Send ONE paid request to OpenAI. Without it, nothing is sent (dry run).
      --json            Print the result as JSON
      --case <id>       Evaluation case id to store in the saved record
      --output <file>   Save an evaluation record (live mode only; never overwrites).
                        Records hold the fingerprint or the reason there is none,
                        settings, usage and the image SHA-256, never image bytes or keys.
  -h, --help            Show this help

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

  let args: { file?: string; live?: boolean; json?: boolean; help?: boolean; case?: string; output?: string };
  try {
    // pnpm may forward a literal "--" separator; it carries no meaning here.
    ({ values: args } = parseArgs({
      args: argv.filter((arg) => arg !== "--"),
      options: {
        file: { type: "string", short: "f" },
        live: { type: "boolean", default: false },
        json: { type: "boolean", default: false },
        help: { type: "boolean", short: "h", default: false },
        case: { type: "string" },
        output: { type: "string" },
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

  if (args.case !== undefined && !/^[a-z0-9][a-z0-9-]*$/.test(args.case)) {
    io.err("Error: --case must use lower-case letters, digits and hyphens");
    return EXIT_USAGE;
  }

  const outputPath = args.output === undefined ? undefined : resolve(deps.cwd, args.output);
  if (outputPath) {
    const problem = await checkOutputDestination(outputPath);
    if (problem) {
      io.err(`Error: cannot save the record to ${args.output}: ${problem}`);
      return EXIT_USAGE;
    }
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
      ...(args.output ? [`Record:           would be saved to ${args.output} in --live mode (nothing written now)`] : []),
      ...(args.case ? [`Case id:          ${args.case}`] : []),
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

  if (outputPath) {
    // Create the folder before paying for a request, so saving cannot fail on it.
    try {
      await mkdir(dirname(outputPath), { recursive: true });
      await access(dirname(outputPath), constants.W_OK);
    } catch {
      io.err(`Error: cannot save the record to ${args.output}: folder cannot be created or written`);
      return EXIT_USAGE;
    }
  }

  const images = new InMemoryImageContentProvider();
  images.register(reference.id, content);
  const service = (deps.createService ?? defaultCreateService)(
    { apiKey: config.apiKey, model: config.model },
    images,
  );

  const clock = deps.clock ?? (() => performance.now());
  const started = clock();
  let outcome: RunOutcome;
  try {
    outcome = { ok: true, details: await service.analyzeWithDetails(reference) };
  } catch (error) {
    outcome = { ok: false, error };
  }
  const durationMs = Math.max(0, Math.round(clock() - started));

  if (outcome.ok) {
    const { details } = outcome;
    if (args.json) {
      io.out(JSON.stringify({ referenceId: reference.id, responseId: details.responseId, usage: details.usage ?? null, fingerprint: details.fingerprint }, null, 2));
    } else {
      formatAnalysis(details).forEach((line) => io.out(line));
    }
  } else {
    reportFailure(outcome.error, io);
  }
  const exitCode = outcome.ok ? EXIT_OK : EXIT_ANALYSIS_FAILED;

  if (!outputPath) return exitCode;

  const record = buildRunRecord({
    caseId: args.case ?? null,
    recordedAt: now().toISOString(),
    dataSource: outcome.ok ? outcome.details.fingerprint.source.dataSource : "live",
    image: content,
    referenceId: reference.id,
    settings,
    instructionsVersion: FURNITURE_UNDERSTANDING_INSTRUCTIONS_VERSION,
    durationMs,
    outcome,
  });
  const json = `${JSON.stringify(record, null, 2)}\n`;
  try {
    await writeFile(outputPath, json, { flag: "wx" });
    io.err(`Saved evaluation record to ${args.output}`);
    return exitCode;
  } catch {
    // Do not lose a paid result: print the record so it can be saved by hand.
    io.err(`Error: could not write ${args.output}; the record follows on stdout.`);
    io.out(json);
    return EXIT_ANALYSIS_FAILED;
  }
}

/** Returns a problem description, or undefined if the destination is usable. */
async function checkOutputDestination(path: string): Promise<string | undefined> {
  if (extname(path).toLowerCase() !== ".json") return "the file name must end in .json";
  try {
    await stat(path);
    return "a file or folder already exists there (records are never overwritten)";
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOTDIR") return "the parent path is not a folder";
    if (code !== "ENOENT") return "the path cannot be checked";
  }
  try {
    const parent = await stat(dirname(path));
    if (!parent.isDirectory()) return "the parent path is not a folder";
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") return "the parent folder cannot be checked";
  }
  return undefined;
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
