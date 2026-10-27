import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { syntheticRawVerification } from "../verification/openai/test-fixtures";
import { LISTING_A, LISTING_B, writeOrchestrationCase, writeSavedShortlist, writeSolRecord } from "../orchestration/test-fixtures";
import { TEST_CASE } from "../shortlisting/test-fixtures";
import { localPaths } from "./local-access";
import { startOfflineRun } from "./offline-run";

/**
 * TEST-ONLY repository-shaped folder (<root>/evals/local/...) with a
 * live-shaped [TEST] case, a saved shortlist and two saved Sol records made by
 * the real mapper from hand-written outputs, and one real orchestration run
 * over them. No genuine listing, supplier or model output is used.
 */
export async function makeUiRepo(opts: { run?: boolean } = {}) {
  const root = await mkdtemp(join(tmpdir(), "vfsa-ui-"));
  await writeFile(join(root, "pnpm-workspace.yaml"), "packages: []\n");
  const local = join(root, "evals/local");
  await writeOrchestrationCase(local);
  await writeSavedShortlist(local);
  await writeSolRecord(local, { listingId: LISTING_A, imageFile: "a.png", raw: syntheticRawVerification({ design_similarity_index: 79, classification: "close_variant" }) });
  await writeSolRecord(local, { listingId: LISTING_B, imageFile: "b-primary.png", raw: syntheticRawVerification({ design_similarity_index: 55, classification: "similar_alternative" }) });
  const paths = localPaths(root);
  let runId: string | null = null;
  if (opts.run !== false) {
    const outcome = await startOfflineRun(paths, TEST_CASE, { runner: null });
    if (!outcome.ok) throw new Error(`fixture run failed: ${outcome.message}`);
    runId = outcome.runId;
  }
  return { root, local, paths, runId, caseId: TEST_CASE };
}

/** A Request as the local browser would send it. */
export function localRequest(path: string, init: RequestInit & { origin?: string | null; host?: string } = {}) {
  const headers = new Headers(init.headers);
  headers.set("host", init.host ?? "localhost:3000");
  if (init.origin !== null) headers.set("origin", init.origin ?? "http://localhost:3000");
  return new Request(`http://localhost:3000${path}`, { ...init, headers });
}
