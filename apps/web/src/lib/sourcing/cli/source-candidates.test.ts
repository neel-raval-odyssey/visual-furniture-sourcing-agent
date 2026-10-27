import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { liveShapedManifest, liveShapedRunRecord, REPO_ROOT, syntheticManifest } from "../discovery/curated/test-fixtures";
import { SOURCE_EXIT_INVALID, SOURCE_EXIT_OK, SOURCE_EXIT_USAGE, runSourceCandidatesCli } from "./source-candidates";

// The intake CLI must work without the OpenAI SDK: loading it fails this test file.
vi.mock("openai", () => {
  throw new Error("source:candidates must not load the OpenAI SDK");
});

let dir: string;
const fetchSpy = vi.fn();

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "vfsa-source-"));
  await cp(join(REPO_ROOT, "evals/image-understanding/synthetic/predictions"), join(dir, "predictions"), { recursive: true });
  await cp(join(REPO_ROOT, "evals/candidates/synthetic"), join(dir, "candidates"), { recursive: true });

  // A real-shaped saved run for the genuine-record path (test only).
  const raw = liveShapedRunRecord();
  await writeFile(join(dir, "predictions/test-live-bed.json"), JSON.stringify(raw));
});

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

beforeEach(() => {
  vi.stubGlobal("fetch", fetchSpy);
  vi.stubEnv("OPENAI_API_KEY", "sk-test-present-but-unused");
});

afterEach(() => {
  expect(fetchSpy).not.toHaveBeenCalled();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

function cli() {
  const out: string[] = [];
  const err: string[] = [];
  return {
    out,
    err,
    text: () => out.join("\n"),
    run: (...argv: string[]) =>
      runSourceCandidatesCli(argv, { cwd: dir, repoRoot: dir, io: { out: (l) => out.push(l), err: (l) => err.push(l) } }),
  };
}

const syn = ["--case", "syn-bed-001", "--synthetic", "--predictions", "predictions", "--candidates", "candidates"];

describe("source:candidates", () => {
  it("prints help and rejects bad usage", async () => {
    const help = cli();
    expect(await help.run("--help")).toBe(SOURCE_EXIT_OK);
    expect(help.text()).toContain("searches nothing");
    expect(await cli().run("--prepare")).toBe(SOURCE_EXIT_USAGE);
    expect(await cli().run("--case", "syn-bed-001", "--prepare", "--run")).toBe(SOURCE_EXIT_USAGE);
    expect(await cli().run(...syn, "--run", "--limit", "0")).toBe(SOURCE_EXIT_USAGE);
  });

  it("prepares a handoff and a blank manifest offline, without overwriting", async () => {
    const c = cli();
    expect(await c.run("--case", "test-live-bed", "--predictions", "predictions", "--candidates", "private", "--prepare")).toBe(SOURCE_EXIT_OK);
    const text = c.text();
    expect(text).toContain("This command searched nothing");
    expect(text).toContain("ref-test-live");
    expect(text).toContain("https://sale.alibaba.com/p/lens/");
    expect(text).toContain("arched panel bed"); // saved query, unchanged
    expect(text).toContain("private/test-live-bed.json");
    const template = JSON.parse(await readFile(join(dir, "private/test-live-bed.json"), "utf8"));
    expect(template).toMatchObject({
      dataSource: "live",
      caseId: "test-live-bed",
      fingerprintId: "fp-test-live",
      capture: { status: "not_started", capturedAt: null },
      candidates: [],
    });

    await writeFile(join(dir, "private/test-live-bed.json"), JSON.stringify({ ...template, capture: { ...template.capture, notes: "mine" } }));
    const again = cli();
    expect(await again.run("--case", "test-live-bed", "--predictions", "predictions", "--candidates", "private", "--prepare")).toBe(SOURCE_EXIT_OK);
    expect(again.text()).toContain("already exists and was not changed");
    expect(JSON.parse(await readFile(join(dir, "private/test-live-bed.json"), "utf8")).capture.notes).toBe("mine");
  });

  it("distinguishes missing input from an empty search", async () => {
    const missing = cli();
    expect(await missing.run("--case", "test-live-bed", "--predictions", "predictions", "--candidates", "nowhere", "--run")).toBe(SOURCE_EXIT_USAGE);
    expect(missing.err[0]).toContain("missing input, not evidence that Alibaba.com has no matches");

    await mkdir(join(dir, "blank"), { recursive: true });
    const blank = cli();
    await blank.run("--case", "test-live-bed", "--predictions", "predictions", "--candidates", "blank", "--prepare");
    const unfinished = cli();
    expect(await unfinished.run("--case", "test-live-bed", "--predictions", "predictions", "--candidates", "blank", "--run")).toBe(SOURCE_EXIT_USAGE);
    expect(unfinished.err[0]).toContain("not filled in yet");

    await mkdir(join(dir, "empty"), { recursive: true });
    await writeFile(join(dir, "empty/test-live-bed.json"), JSON.stringify(liveShapedManifest({ candidates: [], suppliers: [] })));
    const empty = cli();
    expect(await empty.run("--case", "test-live-bed", "--predictions", "predictions", "--candidates", "empty", "--run")).toBe(SOURCE_EXIT_OK);
    expect(empty.text()).toContain("Candidates: 0");
    expect(empty.text()).toContain("completed search with no candidates");
  });

  it("validates the synthetic sample and requires --synthetic for it", async () => {
    const c = cli();
    expect(await c.run(...syn, "--validate")).toBe(SOURCE_EXIT_OK);
    expect(c.text()).toMatch(/^SYNTHETIC/);
    expect(c.text()).toContain("Would import 3 listing(s) and 2 supplier(s)");
    expect(c.text()).toContain("1 without image evidence");

    const noFlag = cli();
    expect(await noFlag.run("--case", "syn-bed-001", "--predictions", "predictions", "--candidates", "candidates", "--validate")).toBe(SOURCE_EXIT_USAGE);
    expect(noFlag.err[0]).toContain("--synthetic");
  });

  it("reports invalid manifests and wrong case associations", async () => {
    await mkdir(join(dir, "bad"), { recursive: true });
    const lookalike = liveShapedManifest();
    lookalike.candidates[0] = { ...lookalike.candidates[0], listingUrl: "https://www.alibaba.com.example.net/product-detail/x_0000000001.html" };
    await writeFile(join(dir, "bad/test-live-bed.json"), JSON.stringify(lookalike));
    const c = cli();
    expect(await c.run("--case", "test-live-bed", "--predictions", "predictions", "--candidates", "bad", "--validate")).toBe(SOURCE_EXIT_INVALID);
    expect(c.err.join("\n")).toContain("candidates[0].listingUrl");

    await writeFile(join(dir, "bad/wrong-case.json"), JSON.stringify(syntheticManifest()));
    const wrong = cli();
    expect(await wrong.run("--case", "test-live-bed", "--predictions", "predictions", "--manifest", "bad/wrong-case.json", "--validate")).toBe(
      SOURCE_EXIT_INVALID,
    );
    const errors = wrong.err.join("\n");
    expect(errors).toContain('caseId is "syn-bed-001", expected "test-live-bed"');
    expect(errors).toContain("pass --synthetic");

    await writeFile(join(dir, "bad/broken.json"), "{ not json");
    expect(await cli().run("--case", "test-live-bed", "--predictions", "predictions", "--manifest", "bad/broken.json", "--validate")).toBe(SOURCE_EXIT_INVALID);
  });

  it("checks that local image evidence exists", async () => {
    await mkdir(join(dir, "local/test-live-bed"), { recursive: true });
    const m = liveShapedManifest();
    m.candidates[0] = { ...m.candidates[0], images: [{ localPath: "test-live-bed/listing-1.png" }] };
    await writeFile(join(dir, "local/test-live-bed.json"), JSON.stringify(m));
    const args = ["--case", "test-live-bed", "--predictions", "predictions", "--candidates", "local", "--validate"];
    const missing = cli();
    expect(await missing.run(...args)).toBe(SOURCE_EXIT_INVALID);
    expect(missing.err.join("\n")).toContain("file not found");
    await writeFile(join(dir, "local/test-live-bed/listing-1.png"), "png");
    expect(await cli().run(...args)).toBe(SOURCE_EXIT_OK);
  });

  it("refuses run records without a fingerprint", async () => {
    const c = cli();
    expect(await c.run("--case", "syn-landscape-001", "--synthetic", "--predictions", "predictions", "--prepare")).toBe(SOURCE_EXIT_INVALID);
    expect(c.err[0]).toContain("no fingerprint");
    expect(await cli().run("--case", "no-such-case", "--predictions", "predictions", "--prepare")).toBe(SOURCE_EXIT_USAGE);
  });

  it("runs the synthetic sample end to end, labelled synthetic and not assessed", async () => {
    const c = cli();
    expect(await c.run(...syn, "--run")).toBe(SOURCE_EXIT_OK);
    const text = c.text();
    expect(text).toMatch(/^SYNTHETIC/);
    expect(text).toContain("Acquisition: operator_assisted via curated-alibaba");
    expect(text).toContain("This application performed no search");
    expect(text).toContain("UNSUITABLE for visual comparison");
    expect(text).not.toMatch(/similarity \d|confidence: (low|medium|high)/);

    const json = cli();
    expect(await json.run(...syn, "--run", "--json", "--limit", "2")).toBe(SOURCE_EXIT_OK);
    const { summary, result } = JSON.parse(json.text());
    expect(summary).toMatchObject({
      synthetic: true,
      acquisition: { method: "operator_assisted", searchPerformedByApplication: false },
      counts: { candidates: 2, excludedByLimit: 1 },
      visualVerification: { status: "not_implemented", assessedCandidates: 0 },
    });
    expect(summary.candidates.every((x: { visualVerification: string }) => x.visualVerification === "not_assessed")).toBe(true);
    expect(result.assessments).toEqual([]);
    expect(result.results.every((r: { assessment?: unknown }) => r.assessment === undefined)).toBe(true);
    expect(result.discovery.listings[0].images[0].uri).toBe("https://images.example.com/synthetic/bed-1-primary.jpg");
  });

  it("runs a genuine-shaped manifest as live data", async () => {
    await mkdir(join(dir, "live"), { recursive: true });
    await writeFile(join(dir, "live/test-live-bed.json"), JSON.stringify(liveShapedManifest()));
    const c = cli();
    expect(await c.run("--case", "test-live-bed", "--predictions", "predictions", "--candidates", "live", "--run", "--json")).toBe(SOURCE_EXIT_OK);
    const { summary } = JSON.parse(c.text());
    expect(summary.synthetic).toBe(false);
    expect(summary.candidates[0]).toMatchObject({ listingId: "alibaba-product-0000000001", supplier: { name: "[TEST] Supplier" } });
  });
});
