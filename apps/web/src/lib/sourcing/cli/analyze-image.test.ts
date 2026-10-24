import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { TEST_PNG, TEST_TEXT } from "../image-input/test-fixtures";
import { runRecordSchema } from "../evaluation/run-record";
import { FurnitureNotIdentifiedError, VisionModelError } from "../understanding/openai/errors";
import { mapRawAnalysisToFingerprint } from "../understanding/openai/mapping";
import { SYNTHETIC_RAW_CHAIR } from "../understanding/openai/test-fixtures";
import {
  EXIT_ANALYSIS_FAILED,
  EXIT_OK,
  EXIT_USAGE,
  runAnalyzeImageCli,
  type AnalyzeImageCliDeps,
  type AnalyzeImageService,
} from "./analyze-image";

const FAKE_KEY = "sk-test-NOT-A-REAL-KEY-1234567890";
let dir: string;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "vfsa-cli-"));
  await writeFile(join(dir, "chair.png"), TEST_PNG);
  await writeFile(join(dir, "fake.jpg"), TEST_TEXT);
});

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function setup(options: { env?: Record<string, string | undefined>; service?: AnalyzeImageService } = {}) {
  const out: string[] = [];
  const err: string[] = [];
  const createService = vi.fn<NonNullable<AnalyzeImageCliDeps["createService"]>>(
    () => options.service ?? successService(),
  );
  const deps: AnalyzeImageCliDeps = {
    env: options.env ?? { OPENAI_API_KEY: FAKE_KEY },
    cwd: dir,
    io: { out: (l) => out.push(l), err: (l) => err.push(l) },
    now: () => new Date("2026-10-24T10:00:00.000Z"),
    createService,
  };
  const run = (...argv: string[]) => runAnalyzeImageCli(argv, deps);
  return { run, out, err, createService, all: () => [...out, ...err].join("\n") };
}

function successService(): AnalyzeImageService {
  return {
    analyzeWithDetails: vi.fn(async (reference) => ({
      fingerprint: mapRawAnalysisToFingerprint(SYNTHETIC_RAW_CHAIR, reference, {
        fingerprintId: "fp-test-1",
        createdAt: "2026-10-24T10:00:00.000Z",
        modelId: "gpt-6-luna",
      }),
      responseId: "resp_synthetic_1",
      usage: { inputTokens: 1200, outputTokens: 300, totalTokens: 1500, reasoningTokens: 80 },
    })),
  };
}

const failingService = (error: Error): AnalyzeImageService => ({
  analyzeWithDetails: vi.fn(async () => {
    throw error;
  }),
});

describe("argument handling", () => {
  it("prints help", async () => {
    const cli = setup();
    expect(await cli.run("--help")).toBe(EXIT_OK);
    expect(cli.out.join("\n")).toContain("--live");
  });

  it("requires --file", async () => {
    const cli = setup();
    expect(await cli.run()).toBe(EXIT_USAGE);
    expect(cli.err[0]).toContain("--file");
  });

  it("rejects unknown options and positional arguments", async () => {
    expect(await setup().run("--file", "chair.png", "--livee")).toBe(EXIT_USAGE);
    expect(await setup().run("chair.png")).toBe(EXIT_USAGE);
  });

  it("accepts a forwarded '--' separator and the short -f flag", async () => {
    expect(await setup().run("--", "-f", "chair.png")).toBe(EXIT_OK);
  });

  it("fails with a usage exit code for invalid images, naming only the file", async () => {
    const cli = setup();
    expect(await cli.run("--file", "fake.jpg")).toBe(EXIT_USAGE);
    expect(cli.err[0]).toContain("unsupported_format");
    expect(cli.err[0]).toContain("fake.jpg");
    expect(cli.err[0]).not.toContain(dir);

    expect(await setup().run("--file", "missing.png")).toBe(EXIT_USAGE);
  });
});

describe("dry run (default)", () => {
  it("validates the image and settings without creating a client or using the network", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    const cli = setup();

    expect(await cli.run("--file", "chair.png")).toBe(EXIT_OK);

    expect(cli.createService).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
    const output = cli.out.join("\n");
    expect(output).toContain("DRY RUN: no request was sent to OpenAI.");
    expect(output).toContain("image/png");
    expect(output).toContain("gpt-6-luna");
    expect(output).toMatch(/OPENAI_API_KEY:\s+set/);
    expect(cli.all()).not.toContain(FAKE_KEY);
  });

  it("works without an API key and says it is required for --live", async () => {
    const cli = setup({ env: {} });
    expect(await cli.run("--file", "chair.png")).toBe(EXIT_OK);
    expect(cli.out.join("\n")).toContain("NOT SET (required for --live)");
  });

  it("shows the configured model", async () => {
    const cli = setup({ env: { OPENAI_IMAGE_UNDERSTANDING_MODEL: "gpt-6-luna-custom" } });
    await cli.run("--file", "chair.png");
    expect(cli.out.join("\n")).toContain("gpt-6-luna-custom");
  });

  it("supports JSON output without the key or image bytes", async () => {
    const cli = setup();
    await cli.run("--file", "chair.png", "--json");
    const json = JSON.parse(cli.out.join("\n"));
    expect(json).toMatchObject({ dryRun: true, mimeType: "image/png", apiKeySet: true });
    expect(cli.all()).not.toContain(FAKE_KEY);
    expect(cli.all()).not.toContain(Buffer.from(TEST_PNG).toString("base64"));
  });
});

describe("live mode", () => {
  it("requires an API key and does not create a client without one", async () => {
    const cli = setup({ env: {} });
    expect(await cli.run("--file", "chair.png", "--live")).toBe(EXIT_USAGE);
    expect(cli.err[0]).toContain("OPENAI_API_KEY is not set");
    expect(cli.err[0]).toContain("apps/web/.env.local");
    expect(cli.createService).not.toHaveBeenCalled();
  });

  it("prints a readable analysis without secrets", async () => {
    const cli = setup();
    expect(await cli.run("--file", "chair.png", "--live")).toBe(EXIT_OK);

    expect(cli.createService).toHaveBeenCalledTimes(1);
    expect(cli.createService.mock.calls[0][0]).toEqual({ apiKey: FAKE_KEY, model: "gpt-6-luna" });
    const output = cli.out.join("\n");
    for (const expected of [
      "Reference id:   ref-local-",
      "Model:          gpt-6-luna",
      "Category:       chair / dining_chair",
      "Structure (observed):",
      "  - backrest_shape: single curved panel",
      "Appearance (observed):",
      "Inferred (not verified):",
      "  - frame_material: solid wood (Visible grain; could be veneer.)",
      "Unknown:",
      "  - wood_species (Not determinable from a photo.)",
      "Distinctive features (observed):",
      "  - curved back dining chair",
      "kind=model, dataSource=live",
      "Token usage:    input 1200, output 300 (reasoning 80), total 1500",
    ]) {
      expect(output).toContain(expected);
    }
    expect(cli.all()).not.toContain(FAKE_KEY);
    expect(cli.all()).not.toContain(Buffer.from(TEST_PNG).toString("base64"));
  });

  it("prints JSON in live mode", async () => {
    const cli = setup();
    await cli.run("--file", "chair.png", "--live", "--json");
    const json = JSON.parse(cli.out.join("\n"));
    expect(json.fingerprint.source).toEqual({ kind: "model", dataSource: "live", modelId: "gpt-6-luna" });
    expect(json.usage.totalTokens).toBe(1500);
  });

  it("exits nonzero with the error category on model failures", async () => {
    const cli = setup({
      service: failingService(new VisionModelError("authentication", "OpenAI rejected the API key (401)", { requestId: "req_1" })),
    });
    expect(await cli.run("--file", "chair.png", "--live")).toBe(EXIT_ANALYSIS_FAILED);
    expect(cli.err.join("\n")).toContain("[authentication]");
    expect(cli.err.join("\n")).toContain("req_1");
    expect(cli.all()).not.toContain(FAKE_KEY);
  });

  it("exits nonzero when the model finds no furniture", async () => {
    const cli = setup({
      service: failingService(new FurnitureNotIdentifiedError("no_furniture", "The image shows a landscape.")),
    });
    expect(await cli.run("--file", "chair.png", "--live")).toBe(EXIT_ANALYSIS_FAILED);
    expect(cli.err.join("\n")).toContain('"no_furniture"');
    expect(cli.out).toEqual([]);
  });

  it("exits nonzero on unexpected errors without printing their details", async () => {
    const cli = setup({ service: failingService(new Error(`leaked ${FAKE_KEY}`)) });
    expect(await cli.run("--file", "chair.png", "--live")).toBe(EXIT_ANALYSIS_FAILED);
    expect(cli.all()).not.toContain(FAKE_KEY);
  });
});

describe("evaluation records (--output, --case)", () => {
  const record = async (name: string) => runRecordSchema.parse(JSON.parse(await readFile(join(dir, name), "utf8")));

  it("does not write a record or enable live mode in a dry run", async () => {
    const cli = setup();
    expect(await cli.run("--file", "chair.png", "--output", "dry.json", "--case", "ettrick-bed")).toBe(EXIT_OK);
    expect(cli.createService).not.toHaveBeenCalled();
    expect(existsSync(join(dir, "dry.json"))).toBe(false);
    expect(cli.out.join("\n")).toContain("would be saved to dry.json in --live mode");
  });

  it("saves a valid record in live mode while keeping stdout unchanged", async () => {
    const cli = setup();
    expect(await cli.run("--file", "chair.png", "--live", "--json", "--case", "ettrick-bed", "--output", "records/run-1.json")).toBe(EXIT_OK);

    const saved = await record("records/run-1.json");
    expect(saved).toMatchObject({
      caseId: "ettrick-bed",
      dataSource: "live",
      request: { model: "gpt-6-luna", instructionsVersion: "2026-10-24.1", imageDetail: "high", reasoningEffort: "low", maxOutputTokens: 4096 },
      response: { responseId: "resp_synthetic_1", usage: { totalTokens: 1500 } },
      result: { kind: "furniture_identified" },
    });
    expect(saved.response.durationMs).toBeGreaterThanOrEqual(0);
    expect(JSON.parse(cli.out.join("\n"))).toHaveProperty("fingerprint");
    expect(cli.err.join("\n")).toContain("Saved evaluation record to records/run-1.json");

    const text = await readFile(join(dir, "records/run-1.json"), "utf8");
    expect(text).not.toContain(FAKE_KEY);
    expect(text).not.toContain(Buffer.from(TEST_PNG).toString("base64"));
    expect(text).not.toContain(dir);
  });

  it("refuses an existing destination before any request is made", async () => {
    await writeFile(join(dir, "taken.json"), "{}");
    const cli = setup();
    expect(await cli.run("--file", "chair.png", "--live", "--output", "taken.json")).toBe(EXIT_USAGE);
    expect(cli.err[0]).toContain("never overwritten");
    expect(cli.createService).not.toHaveBeenCalled();
    expect(await readFile(join(dir, "taken.json"), "utf8")).toBe("{}");
  });

  it.each([
    ["a non-JSON file name", "record.txt", /must end in .json/],
    ["a parent path that is a file", "chair.png/record.json", /parent path is not a folder/],
  ])("rejects %s before any request is made", async (_name, output, message) => {
    const cli = setup();
    expect(await cli.run("--file", "chair.png", "--live", "--output", output)).toBe(EXIT_USAGE);
    expect(cli.err[0]).toMatch(message);
    expect(cli.createService).not.toHaveBeenCalled();
  });

  it("rejects an invalid --case id", async () => {
    const cli = setup();
    expect(await cli.run("--file", "chair.png", "--case", "Ettrick Bed")).toBe(EXIT_USAGE);
  });

  it("saves a correct rejection as not_identified with its usage, keeping exit code 1", async () => {
    const error = new FurnitureNotIdentifiedError("no_furniture", "The image shows a landscape.");
    error.response = { responseId: "resp_2", responseModel: "gpt-6-luna", usage: { inputTokens: 900, outputTokens: 60, totalTokens: 960 } };
    const cli = setup({ service: failingService(error) });

    expect(await cli.run("--file", "chair.png", "--live", "--output", "rejection.json")).toBe(EXIT_ANALYSIS_FAILED);
    const saved = await record("rejection.json");
    expect(saved.result).toEqual({ kind: "not_identified", modelOutcome: "no_furniture", modelReason: "The image shows a landscape." });
    expect(saved.response).toMatchObject({ responseId: "resp_2", usage: { totalTokens: 960 } });
    expect(saved.caseId).toBeNull();
  });

  it("saves model errors with their category and no secrets", async () => {
    const cli = setup({ service: failingService(new VisionModelError("authentication", "OpenAI rejected the API key (401)", { status: 401, requestId: "req_9" })) });
    expect(await cli.run("--file", "chair.png", "--live", "--output", "auth-error.json")).toBe(EXIT_ANALYSIS_FAILED);
    const saved = await record("auth-error.json");
    expect(saved.result).toEqual({ kind: "error", errorCategory: "authentication", message: "OpenAI rejected the API key (401)", status: 401, requestId: "req_9" });
    expect(JSON.stringify(saved)).not.toContain(FAKE_KEY);
  });

  it("prints the record instead of losing it when the file cannot be written", async () => {
    const target = join(dir, "raced.json");
    const service = successService();
    const analyze = service.analyzeWithDetails;
    service.analyzeWithDetails = vi.fn(async (reference) => {
      await writeFile(target, "created during the request");
      return analyze(reference);
    });
    const cli = setup({ service });

    expect(await cli.run("--file", "chair.png", "--live", "--output", "raced.json")).toBe(EXIT_ANALYSIS_FAILED);
    expect(cli.err.join("\n")).toContain("could not write raced.json");
    expect(runRecordSchema.safeParse(JSON.parse(cli.out.at(-1) ?? "")).success).toBe(true);
    expect(await readFile(target, "utf8")).toBe("created during the request");
  });

  it("keeps the help text and documents the new options", async () => {
    const cli = setup();
    expect(await cli.run("--help")).toBe(EXIT_OK);
    expect(cli.out.join("\n")).toMatch(/--output <file>[\s\S]*never overwrites/);
  });
});
