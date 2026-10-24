import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { reviewRecordSchema } from "../evaluation/review";
import { EVAL_EXIT_OK, EVAL_EXIT_USAGE, runEvalImagesCli } from "./eval-images";

// The evaluator must work without the OpenAI SDK: loading it fails this test file.
vi.mock("openai", () => {
  throw new Error("The offline evaluator must not load the OpenAI SDK");
});

const repoRoot = fileURLToPath(new URL("../../../../../../", import.meta.url));
let dir: string;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "vfsa-eval-"));
  await cp(join(repoRoot, "evals/image-understanding/synthetic"), join(dir, "synthetic"), { recursive: true });
});

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

function cli() {
  const out: string[] = [];
  const err: string[] = [];
  return {
    out,
    err,
    run: (...argv: string[]) =>
      runEvalImagesCli(argv, { cwd: dir, repoRoot: dir, io: { out: (l) => out.push(l), err: (l) => err.push(l) }, now: () => new Date("2026-10-25T12:00:00.000Z") }),
  };
}

const synthetic = (output: string) => [
  "--dataset", "synthetic/dataset.json",
  "--predictions", "synthetic/predictions",
  "--reviews", "synthetic/reviews",
  "--output", output,
];

describe("eval:images", () => {
  it("prints help", async () => {
    const c = cli();
    expect(await c.run("--help")).toBe(EVAL_EXIT_OK);
    expect(c.out.join("\n")).toContain("no API calls");
  });

  it("writes JSON and Markdown reports offline, labelled synthetic", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    vi.stubEnv("OPENAI_API_KEY", "sk-test-present-but-unused");
    const c = cli();

    expect(await c.run(...synthetic("reports-a"))).toBe(EVAL_EXIT_OK);

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(c.out[0]).toMatch(/^SYNTHETIC/);
    const report = JSON.parse(await readFile(join(dir, "reports-a/report.json"), "utf8"));
    expect(report.run).toMatchObject({ synthetic: true, datasetPurpose: "tooling_test", usablePredictions: 6 });
    expect(report.run.runId).toMatch(/^eval-20261025T120000Z-[0-9a-f]{8}$/);
    expect(report.automated.casesWithRun).toMatchObject({ numerator: 6, denominator: 7 });
    expect(report.missing.loadIssues).toContainEqual(expect.objectContaining({ file: "broken.json", problem: "malformed_json" }));
    const markdown = await readFile(join(dir, "reports-a/report.md"), "utf8");
    expect(markdown).toMatch(/^# Image understanding evaluation — SYNTHETIC/);
  });

  it("refuses to replace existing reports unless --force is given", async () => {
    expect(await cli().run(...synthetic("reports-b"))).toBe(EVAL_EXIT_OK);
    const second = cli();
    expect(await second.run(...synthetic("reports-b"))).toBe(EVAL_EXIT_USAGE);
    expect(second.err[0]).toContain("--force");
    expect(await cli().run(...synthetic("reports-b"), "--force")).toBe(EVAL_EXIT_OK);
  });

  it("produces the same metrics for the same inputs", async () => {
    await cli().run(...synthetic("reports-c"));
    await cli().run(...synthetic("reports-d"));
    const [a, b] = await Promise.all(["reports-c", "reports-d"].map((d) => readFile(join(dir, d, "report.json"), "utf8")));
    expect(a).toBe(b);
  });

  it("fails clearly for an invalid or missing dataset", async () => {
    await writeFile(join(dir, "bad-dataset.json"), JSON.stringify({ schemaVersion: 1, cases: [] }));
    const c = cli();
    expect(await c.run("--dataset", "bad-dataset.json", "--output", "reports-e")).toBe(EVAL_EXIT_USAGE);
    expect(c.err[0]).toMatch(/Dataset bad-dataset.json is invalid/);
    expect(await cli().run("--dataset", "missing.json", "--output", "reports-e")).toBe(EVAL_EXIT_USAGE);
  });

  it("reports missing prediction and review folders instead of failing", async () => {
    const c = cli();
    expect(await c.run("--dataset", "synthetic/dataset.json", "--predictions", "nope", "--reviews", "nope", "--output", "reports-f")).toBe(EVAL_EXIT_OK);
    expect(c.out.join("\n")).toMatch(/predictions folder not found/);
    const report = JSON.parse(await readFile(join(dir, "reports-f/report.json"), "utf8"));
    expect(report.automated.casesWithRun).toMatchObject({ numerator: 0, denominator: 7 });
  });

  it("writes a blank review skeleton linked to the latest run, without overwriting", async () => {
    const args = ["--init-review", "syn-landscape-001", "--dataset", "synthetic/dataset.json", "--predictions", "synthetic/predictions", "--reviews", "new-reviews"];
    expect(await cli().run(...args)).toBe(EVAL_EXIT_OK);

    const skeleton = reviewRecordSchema.parse(JSON.parse(await readFile(join(dir, "new-reviews/syn-landscape-001.json"), "utf8")));
    expect(skeleton).toMatchObject({ status: "in_progress", responseId: "resp_synthetic_syn-landscape-001", reviewer: null });

    const again = cli();
    expect(await again.run(...args)).toBe(EVAL_EXIT_USAGE);
    expect(again.err[0]).toMatch(/never overwritten/);
    expect(await cli().run("--init-review", "no-such-case", "--dataset", "synthetic/dataset.json")).toBe(EVAL_EXIT_USAGE);
  });

  it("checks a private image mapping against expected hashes without reporting paths", async () => {
    await writeFile(join(dir, "image.png"), "synthetic image bytes");
    await writeFile(join(dir, "images.json"), JSON.stringify({ schemaVersion: 1, images: { "syn-bed-001": "image.png", "syn-chair-001": "missing.png" } }));
    expect(await cli().run(...synthetic("reports-g"), "--images", "images.json")).toBe(EVAL_EXIT_OK);

    const text = await readFile(join(dir, "reports-g/report.json"), "utf8");
    expect(JSON.parse(text).missing.imageChecks).toEqual([
      { caseId: "syn-bed-001", status: "mismatch" },
      { caseId: "syn-chair-001", status: "missing_file" },
    ]);
    expect(text).not.toContain(dir);
  });
});
