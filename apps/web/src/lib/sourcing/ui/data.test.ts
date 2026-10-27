import { readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { LISTING_A, LISTING_B, LISTING_C, LISTING_D } from "../orchestration/test-fixtures";
import { getReference, getRun, listReferences, listRuns, STALE_RUNNING_MS } from "./data";
import { makeUiRepo } from "./test-fixtures";

const roots: string[] = [];
const fetchSpy = vi.fn();
afterEach(async () => {
  expect(fetchSpy).not.toHaveBeenCalled();
  vi.unstubAllGlobals();
  await Promise.all(roots.splice(0).map((r) => rm(r, { recursive: true, force: true })));
});
async function repo(opts?: { run?: boolean }) {
  vi.stubGlobal("fetch", fetchSpy);
  const r = await makeUiRepo(opts);
  roots.push(r.root);
  return r;
}

describe("web data access", () => {
  it("lists references with honest readiness and loads a validated run", async () => {
    const { paths, caseId, runId } = await repo();
    const refs = await listReferences(paths);
    expect(refs).toHaveLength(1);
    expect(refs[0]).toMatchObject({ caseId, readiness: "results_available", category: "bed", photo: { available: true, url: `/api/sourcing/evidence/reference/${caseId}` }, savedAssessments: 2 });
    expect(JSON.stringify(refs)).not.toContain(paths.root); // no local paths reach the UI

    const run = await getRun(paths, caseId, runId!);
    expect(run?.summary.status).toBe("partial"); // two listings have no usable image
    expect(run?.stages.map((s) => [s.name, s.state])).toEqual([
      ["reference", "completed"],
      ["candidates", "completed"],
      ["image_evidence", "partial"],
      ["shortlist", "reused"],
      ["verification", "reused"],
      ["assembly", "completed"],
    ]);
    const r = run!.result!;
    expect(r.verified.map((e) => [e.listingId, e.verification.designSimilarityIndex])).toEqual([
      [LISTING_A, 79],
      [LISTING_B, 55],
    ]);
    expect(r.unverified.map((e) => [e.listingId, e.verification.designSimilarityIndex, e.imageEvidence.status])).toEqual([
      [LISTING_C, null, "remote_only"],
      [LISTING_D, null, "no_image"],
    ]);
    expect(r.verified[0].verification.partialStructuralDifferences.map((x) => x.feature)).toEqual(["Headboard Arch Count"]);
    expect(r.verified[0].supplier?.name).toBe("[TEST] Supplier A");
    expect(r.verified[1].product.missingFields).toContain("price");
  });

  it("reports a reference without runs or candidates truthfully", async () => {
    const { paths, caseId } = await repo({ run: false });
    expect((await getReference(paths, caseId))?.readiness).toBe("ready_for_offline_run");
    await rm(join(paths.candidates, `${caseId}.json`));
    expect((await getReference(paths, caseId))?.readiness).toBe("no_candidates");
    await rm(join(paths.root, "evals/local/photos/reference.png"));
    const ref = await getReference(paths, caseId);
    expect(ref?.photo).toMatchObject({ available: false, url: null });
    expect(await getReference(paths, "no-such-case")).toBeNull();
    expect(await getReference(paths, "../etc")).toBeNull();
  });

  it("flags unreadable results, invalid journals and stale running runs", async () => {
    const { paths, caseId, runId } = await repo();
    const runDir = join(paths.sourcingRuns, caseId, runId!);
    await writeFile(join(runDir, "result.json"), JSON.stringify({ recordType: "sourcing_result", verified: "nope" }));
    const broken = await getRun(paths, caseId, runId!);
    expect(broken?.result).toBeNull();
    expect(broken?.resultProblem).toMatch(/result.json is invalid/);

    const journal = JSON.parse(await readFile(join(runDir, "run.json"), "utf8"));
    await writeFile(join(runDir, "run.json"), JSON.stringify({ ...journal, status: "running", updatedAt: new Date(Date.now() - STALE_RUNNING_MS - 1000).toISOString() }));
    expect((await listRuns(paths, caseId))[0].status).toBe("interrupted");

    await writeFile(join(runDir, "run.json"), "{ not json");
    expect((await listRuns(paths, caseId))[0]).toMatchObject({ status: "invalid", problem: expect.stringContaining("run.json") });
    expect(await getRun(paths, caseId, "src-not-a-run")).toBeNull();
  });
});
