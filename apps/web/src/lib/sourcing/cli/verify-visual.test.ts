/* eslint-disable @typescript-eslint/no-explicit-any -- fake SDK responses */
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import OpenAI from "openai";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { REPO_ROOT } from "../discovery/curated/test-fixtures";
import { TEST_CASE, testManifest, writeTestCase } from "../shortlisting/test-fixtures";
import type { ResponsesParseFn } from "../understanding/openai/vision-client";
import { verificationRecordSchema } from "../verification/openai/record";
import type { VerificationReport } from "../verification/openai/report";
import { fakeApiResponse, makePng, syntheticRawVerification } from "../verification/openai/test-fixtures";
import { OpenAIVisualVerificationClient } from "../verification/openai/verification-client";
import {
  runVerifyVisualCli,
  VERIFY_EXIT_INVALID,
  VERIFY_EXIT_OK,
  VERIFY_EXIT_PERSISTENCE,
  VERIFY_EXIT_REQUEST_FAILED,
  VERIFY_EXIT_USAGE,
} from "./verify-visual";

const LISTING_A = "alibaba-product-0000000001";
const LISTING_B = "alibaba-product-0000000002";

let dir: string;
const fetchSpy = vi.fn();
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "vfsa-verify-cli-"));
  vi.stubGlobal("fetch", fetchSpy);
  await writeTestCase(dir, testManifest(), undefined, { reference: makePng(40, 30, 1), file: (n) => makePng(32, 24, n.length + 2) });
});
afterEach(async () => {
  expect(fetchSpy).not.toHaveBeenCalled();
  vi.unstubAllGlobals();
  await rm(dir, { recursive: true, force: true });
});

function harness(respond: () => Promise<unknown> = async () => fakeApiResponse(syntheticRawVerification()), env: Record<string, string> = { OPENAI_API_KEY: "sk-test-not-real" }) {
  const parse = vi.fn<(body: any, options?: any) => Promise<unknown>>(() => respond());
  const factory = vi.fn((_key: string, model: string, settings: any) => new OpenAIVisualVerificationClient({ parse: parse as unknown as ResponsesParseFn, model, settings }));
  const out: string[] = [];
  const err: string[] = [];
  let tick = 0;
  return {
    parse,
    factory,
    out,
    err,
    text: () => out.join("\n"),
    run: (...argv: string[]) =>
      runVerifyVisualCli([...argv, "--predictions", "predictions", "--candidates", "candidates", "--images", "images.json", "--output-dir", "verifications"], {
        cwd: dir,
        repoRoot: dir,
        env,
        createClient: factory,
        // Distinct, increasing timestamps so record files never collide.
        now: () => new Date(Date.UTC(2026, 9, 26, 12, 0, tick++)),
        io: { out: (l) => out.push(l), err: (l) => err.push(l) },
      }),
  };
}

const live = ["--case", TEST_CASE, "--live"];
async function recordFiles(listing = LISTING_A) {
  try {
    return (await readdir(join(dir, "verifications", TEST_CASE, listing))).filter((f) => f.endsWith(".json"));
  } catch {
    return [];
  }
}

describe("verify:visual", () => {
  it("rejects ambiguous or unsafe usage", async () => {
    const h = harness();
    expect(await h.run("--case", TEST_CASE, "--live", "--all")).toBe(VERIFY_EXIT_USAGE); // no cap
    expect(await h.run("--case", TEST_CASE, "--live", "--max-paid-requests", "1")).toBe(VERIFY_EXIT_USAGE); // no selection
    expect(await h.run("--case", TEST_CASE, "--live", "--all", "--max-paid-requests", "5")).toBe(VERIFY_EXIT_USAGE); // cap > 4 listings
    expect(await h.run("--case", TEST_CASE, "--max-paid-requests", "1")).toBe(VERIFY_EXIT_USAGE); // cap without --live
    expect(await h.run("--case", TEST_CASE, "--report", "--all")).toBe(VERIFY_EXIT_USAGE);
    expect(await h.run("--case", TEST_CASE, "--live", "--listing-id", LISTING_A, "--all", "--max-paid-requests", "1")).toBe(VERIFY_EXIT_USAGE);
    expect(h.factory).not.toHaveBeenCalled();
    expect(h.parse).not.toHaveBeenCalled();
  });

  it("dry run (and no --live) validates everything and sends nothing", async () => {
    for (const args of [["--dry-run"], [], ["--all"], ["--listing-id", LISTING_A]]) {
      const h = harness();
      expect(await h.run("--case", TEST_CASE, ...args)).toBe(VERIFY_EXIT_OK);
      expect(h.factory).not.toHaveBeenCalled();
      expect(h.parse).not.toHaveBeenCalled();
      expect(h.text()).toContain("no request was sent");
    }
    const h = harness();
    await h.run("--case", TEST_CASE);
    const text = h.text();
    expect(text).toContain("Model gpt-6.1-sol; instructions 2026-10-26.1; detail high; reasoning medium; max output tokens 6000");
    expect(text).toContain(`image ${TEST_CASE}/a.png: image/png 32x24, sha256 `);
    expect(text).toContain("SKIP: no usable image (https://s.alicdn.com/test/0000000003.jpg: remote_url_not_fetched)");
    expect(text).toContain("Paid requests planned: 2.");
    expect(text).toContain("OPENAI_API_KEY: set");
    expect(text).not.toContain("sk-test");
    expect(await readdir(dir)).not.toContain("verifications");
  });

  it("verifies one listing within the cap and saves a valid record", async () => {
    const h = harness();
    expect(await h.run(...live, "--listing-id", LISTING_A, "--max-paid-requests", "1")).toBe(VERIFY_EXIT_OK);
    expect(h.parse).toHaveBeenCalledTimes(1);
    const files = await recordFiles();
    expect(files).toHaveLength(1);
    const text = await readFile(join(dir, "verifications", TEST_CASE, LISTING_A, files[0]), "utf8");
    const record = verificationRecordSchema.parse(JSON.parse(text));
    expect(record).toMatchObject({
      status: "succeeded",
      caseId: TEST_CASE,
      dataSource: "live",
      referenceImageId: "ref-test-live",
      fingerprintId: "fp-test-live",
      listingId: LISTING_A,
      request: { model: "gpt-6.1-sol", instructionsVersion: "2026-10-26.1", reasoningEffort: "medium", imageDetail: "high", store: false, automaticRetries: 0 },
      response: { responseId: "resp_test_123", usage: { inputTokens: 2100, outputTokens: 900, reasoningTokens: 400 } },
      assessment: { listingId: LISTING_A, designSimilarityIndex: 78 },
    });
    expect(text).not.toMatch(/base64|sk-test|\/private\/|\/tmp\//);
    expect(h.text()).toContain("Paid requests sent: 1 of at most 1");
  });

  it("does not repeat a request for an unchanged pair unless --rerun is given", async () => {
    await harness().run(...live, "--listing-id", LISTING_A, "--max-paid-requests", "1");
    const again = harness();
    expect(await again.run(...live, "--listing-id", LISTING_A, "--max-paid-requests", "1")).toBe(VERIFY_EXIT_OK);
    expect(again.parse).not.toHaveBeenCalled();
    expect(again.text()).toContain("SKIP: already recorded (succeeded");
    const rerun = harness();
    expect(await rerun.run(...live, "--listing-id", LISTING_A, "--max-paid-requests", "1", "--rerun")).toBe(VERIFY_EXIT_OK);
    expect(rerun.parse).toHaveBeenCalledTimes(1);
    expect(await recordFiles()).toHaveLength(2); // the earlier success is kept
  });

  it("refuses to start when more requests are planned than the cap allows", async () => {
    const h = harness();
    expect(await h.run(...live, "--all", "--max-paid-requests", "1")).toBe(VERIFY_EXIT_USAGE);
    expect(h.err.join("\n")).toContain("2 request(s) are planned but --max-paid-requests is 1. Nothing was sent.");
    expect(h.factory).not.toHaveBeenCalled();
  });

  it("records failures once, never retries them automatically, and stops after access errors", async () => {
    const h = harness(async () => {
      throw new OpenAI.PermissionDeniedError(403, { message: "no access" }, "no access", new Headers());
    });
    expect(await h.run(...live, "--all", "--max-paid-requests", "2")).toBe(VERIFY_EXIT_REQUEST_FAILED);
    expect(h.parse).toHaveBeenCalledTimes(1);
    expect(h.text()).toContain("Not sent (stopped after an access/rate-limit error): " + LISTING_B);
    const [file] = await recordFiles();
    const record = verificationRecordSchema.parse(JSON.parse(await readFile(join(dir, "verifications", TEST_CASE, LISTING_A, file), "utf8")));
    expect(record).toMatchObject({ status: "failed", error: { category: "permission" }, assessment: null });

    const again = harness();
    expect(await again.run(...live, "--listing-id", LISTING_A, "--max-paid-requests", "1")).toBe(VERIFY_EXIT_OK);
    expect(again.parse).not.toHaveBeenCalled();
    expect(again.text()).toContain("SKIP: already recorded (failed");
  });

  it("treats an interrupted request (pending record) as attempted", async () => {
    const h = harness(async () => {
      throw new Error("process killed");
    });
    expect(await h.run(...live, "--listing-id", LISTING_A, "--max-paid-requests", "1")).toBe(VERIFY_EXIT_REQUEST_FAILED);
    // Simulate an interruption: rewrite the record to the state it has between "request sent" and "result saved".
    const files = await recordFiles();
    const path = join(dir, "verifications", TEST_CASE, LISTING_A, files[0]);
    const record = JSON.parse(await readFile(path, "utf8"));
    await writeFile(path, JSON.stringify({ ...record, status: "requested", completedAt: null, response: null, error: null }));
    const again = harness();
    expect(await again.run(...live, "--listing-id", LISTING_A, "--max-paid-requests", "1")).toBe(VERIFY_EXIT_OK);
    expect(again.parse).not.toHaveBeenCalled();
    expect(again.text()).toContain("SKIP: already recorded (requested");
  });

  it("requires an API key for --live and never falls back to another model", async () => {
    const h = harness(undefined, {});
    expect(await h.run(...live, "--listing-id", LISTING_A, "--max-paid-requests", "1")).toBe(VERIFY_EXIT_USAGE);
    expect(h.factory).not.toHaveBeenCalled();
    const custom = harness();
    await custom.run(...live, "--listing-id", LISTING_A, "--max-paid-requests", "1", "--model", "gpt-6.1-sol");
    expect(custom.factory.mock.calls[0][1]).toBe("gpt-6.1-sol");
  });

  it("builds the offline report from saved records only, keeping failed and unassessed candidates visible", async () => {
    const empty = harness();
    expect(await empty.run("--case", TEST_CASE, "--report", "--json")).toBe(VERIFY_EXIT_OK);
    const r0 = JSON.parse(empty.text()) as VerificationReport;
    expect(r0.counts).toEqual({ listings: 4, verified: 0, abstained: 0, failed: 0, notVerified: 4 });
    expect(r0.entries.every((e) => e.verification.verificationRank === null && e.verification.designSimilarityIndex === null)).toBe(true);

    let call = 0;
    const responses = [
      async () => fakeApiResponse(syntheticRawVerification({ design_similarity_index: 60, classification: "similar_alternative" })),
      async () => fakeApiResponse(null, { status: "incomplete", incomplete_details: { reason: "max_output_tokens" } }),
    ];
    const h = harness(() => responses[call++]());
    await h.run(...live, "--all", "--max-paid-requests", "2");

    const report = harness();
    expect(await report.run("--case", TEST_CASE, "--report", "--json")).toBe(VERIFY_EXIT_OK);
    expect(report.parse).not.toHaveBeenCalled();
    expect(report.factory).not.toHaveBeenCalled();
    const r = JSON.parse(report.text()) as VerificationReport;
    expect(r.counts).toEqual({ listings: 4, verified: 1, abstained: 0, failed: 1, notVerified: 2 });
    expect(r.entries.map((e) => [e.listingId, e.verification.verificationRank, e.verification.status])).toEqual([
      [LISTING_A, 1, "succeeded"],
      ["alibaba-product-0000000002", null, "incomplete"],
      ["alibaba-product-0000000003", null, "not_verified"],
      ["alibaba-product-0000000004", null, "not_verified"],
    ]);
    const failed = r.entries[1].verification;
    expect(failed.designSimilarityIndex).toBeNull();
    expect(failed.error).toContain("max_output_tokens");
    expect(r.entries[0].verification).toMatchObject({ designSimilarityIndex: 60, classification: "similar_alternative", keyMatches: ["headboard_top_rail"], keyMismatches: ["leg_profile"] });
    expect(r.entries[0].shortlist).toEqual({ siglipRank: null, embeddingCosineSimilarity: null, note: "no shortlist" });
    expect(r.synthetic).toBe(false);
    const md = await readFile(join(dir, "verifications", TEST_CASE, "report.md"), "utf8");
    expect(md).toContain("| unranked | [0000000002]");
    expect(md).not.toMatch(/\| 0 \| .*incomplete/);
  });

  it("validates a supplied shortlist and shows it side by side without sending it", async () => {
    const shortlist = {
      recordType: "visual_shortlist",
      schemaVersion: 1,
      caseId: TEST_CASE,
      createdAt: "2026-10-26T10:00:00.000Z",
      synthetic: false,
      model: { id: "google/siglip2-base-patch16-384", revision: "f".repeat(40) },
      reference: { referenceImageId: "ref-test-live", fingerprintId: "fp-test-live", sha256: "0".repeat(64) },
      shortlist: [{ rank: 1, listingId: LISTING_B, image: { ref: "x", sha256: "1".repeat(64) }, embeddingCosineSimilarity: 0.9, visualVerificationStatus: "not_assessed" }],
      belowTopK: [LISTING_A],
      excluded: [{ listingId: "alibaba-product-0000000003", reason: "no_usable_image" }],
    };
    await writeFile(join(dir, "shortlist.json"), JSON.stringify(shortlist));
    const wrong = harness();
    expect(await wrong.run("--case", TEST_CASE, "--report", "--shortlist", "shortlist.json")).toBe(VERIFY_EXIT_INVALID);
    expect(wrong.err.join("\n")).toContain("different case, reference, fingerprint or image");

    const record = JSON.parse(await readFile(join(dir, "predictions", `${TEST_CASE}.json`), "utf8"));
    await writeFile(join(dir, "shortlist.json"), JSON.stringify({ ...shortlist, reference: { ...shortlist.reference, sha256: record.image.sha256 } }));
    const h = harness();
    await h.run(...live, "--listing-id", LISTING_B, "--max-paid-requests", "1", "--shortlist", "shortlist.json");
    const sent = JSON.stringify(h.parse.mock.calls[0][0]);
    expect(sent).not.toContain("0.9,");
    expect(sent).not.toContain("siglip");
    const report = harness();
    expect(await report.run("--case", TEST_CASE, "--report", "--json", "--shortlist", "shortlist.json")).toBe(VERIFY_EXIT_OK);
    const r = JSON.parse(report.text()) as VerificationReport;
    const b = r.entries.find((e) => e.listingId === LISTING_B)!;
    expect(b.shortlist).toEqual({ siglipRank: 1, embeddingCosineSimilarity: 0.9, note: null });
    expect(b.verification.designSimilarityIndex).toBe(78); // the model's own index, not the cosine
    expect(r.entries.find((e) => e.listingId === LISTING_A)!.shortlist.note).toBe("below top-K");
  });

  it("sends nothing when the record cannot be created, and reports unreadable records", async () => {
    await writeFile(join(dir, "blocked"), "a file, not a folder");
    const h = harness();
    const code = await runVerifyVisualCli(
      [...live, "--listing-id", LISTING_A, "--max-paid-requests", "1", "--predictions", "predictions", "--candidates", "candidates", "--images", "images.json", "--output-dir", "blocked"],
      { cwd: dir, repoRoot: dir, env: { OPENAI_API_KEY: "sk-test-not-real" }, createClient: h.factory, io: { out: () => {}, err: (l) => h.err.push(l) } },
    );
    expect(code).toBe(VERIFY_EXIT_PERSISTENCE);
    expect(h.parse).not.toHaveBeenCalled();
    expect(h.err.join("\n")).toContain("that request was not sent");

    await harness().run(...live, "--listing-id", LISTING_A, "--max-paid-requests", "1");
    await writeFile(join(dir, "verifications", TEST_CASE, LISTING_A, "broken.json"), "{ not json");
    const report = harness();
    expect(await report.run("--case", TEST_CASE, "--report", "--json")).toBe(VERIFY_EXIT_OK);
    const r = JSON.parse(report.text()) as VerificationReport;
    expect(r.recordProblems).toEqual([{ file: `${TEST_CASE}/${LISTING_A}/broken.json`, detail: "not valid JSON" }]);
    expect(r.counts.verified).toBe(1);
  });

  it("labels synthetic data in the report", async () => {
    const out: string[] = [];
    const code = await runVerifyVisualCli(
      [
        "--case", "syn-bed-001", "--synthetic", "--report", "--json",
        "--predictions", join(REPO_ROOT, "evals/image-understanding/synthetic/predictions"),
        "--candidates", join(REPO_ROOT, "evals/candidates/synthetic"),
        "--output-dir", "verifications",
      ],
      { cwd: dir, repoRoot: dir, env: {}, io: { out: (l) => out.push(l), err: () => {} } },
    );
    expect(code).toBe(VERIFY_EXIT_OK);
    const r = JSON.parse(out.join("\n")) as VerificationReport;
    expect(r.synthetic).toBe(true);
    expect(r.counts.notVerified).toBe(3);
  });
});
