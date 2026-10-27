import { readdir, readFile, rm, symlink, truncate, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GET as evidenceGET } from "../../../app/api/sourcing/evidence/[...parts]/route";
import { GET as runStatusGET } from "../../../app/api/sourcing/runs/[caseId]/[runId]/route";
import { POST as runsPOST } from "../../../app/api/sourcing/runs/route";
import { POST as uploadsPOST } from "../../../app/api/sourcing/uploads/route";
import { LISTING_A, LISTING_C, readJson } from "../orchestration/test-fixtures";
import { sha256, TEST_CASE } from "../shortlisting/test-fixtures";
import { makeJpeg, makePng } from "../verification/openai/test-fixtures";
import { makeUiRepo, localRequest } from "./test-fixtures";

let ctx: Awaited<ReturnType<typeof makeUiRepo>>;
const fetchSpy = vi.fn();

beforeEach(async () => {
  ctx = await makeUiRepo();
  vi.stubEnv("VFSA_LOCAL_SOURCING_UI", "1");
  vi.stubEnv("VFSA_REPO_ROOT", ctx.root);
  vi.stubEnv("OPENAI_API_KEY", "sk-test-present-but-never-used");
  vi.stubEnv("APIFY_TOKEN", "apify-test-present-but-never-used");
  vi.stubGlobal("fetch", fetchSpy);
});
afterEach(async () => {
  expect(fetchSpy).not.toHaveBeenCalled(); // no OpenAI, Apify, marketplace or image request
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  await rm(ctx.root, { recursive: true, force: true });
});

const evidence = (path: string, init?: Parameters<typeof localRequest>[1]) =>
  evidenceGET(localRequest(`/api/sourcing/evidence/${path}`, { origin: null, ...init }), { params: Promise.resolve({ parts: path.split("/") }) });
const candidate = (listingId = LISTING_A) => `candidate/${TEST_CASE}/${ctx.runId}/${listingId}`;

describe("evidence route", () => {
  it("serves the reference and recorded candidate images with private caching", async () => {
    const ref = await evidence(`reference/${TEST_CASE}`);
    expect(ref.status).toBe(200);
    expect(ref.headers.get("content-type")).toBe("image/png");
    expect(ref.headers.get("cache-control")).toBe("private, no-store");
    expect(sha256(Buffer.from(await ref.arrayBuffer()))).toBe(sha256(await readFile(join(ctx.local, "photos/reference.png"))));
    const cand = await evidence(candidate());
    expect(cand.status).toBe(200);
  });

  it("rejects unknown ids, traversal and listings without a recorded image, without leaking paths", async () => {
    for (const bad of ["reference/..", "reference/../../etc/passwd", "candidate/x", `candidate/${TEST_CASE}/../../etc`, "upload/upl-x", "file/etc/passwd", "reference/%2Fetc%2Fpasswd"]) {
      const res = await evidence(bad);
      expect([400, 404]).toContain(res.status);
      expect(await res.text()).not.toContain(ctx.root);
    }
    expect((await evidence(candidate(LISTING_C))).status).toBe(404); // remote-only listing: nothing local to serve
  });

  it("refuses symlink escapes, changed files, oversized files and unsupported formats", async () => {
    const file = join(ctx.local, "candidates", TEST_CASE, "a.png");
    const original = await readFile(file);
    await writeFile(file, makePng(32, 24, 200));
    expect((await evidence(candidate())).status).toBe(409); // changed since the run

    await rm(file);
    await writeFile(join(ctx.root, "secret.png"), original);
    await symlink(join(ctx.root, "secret.png"), file);
    expect((await evidence(candidate())).status).toBe(400);

    await rm(file);
    expect((await evidence(candidate())).status).toBe(404);

    await writeFile(file, original);
    await truncate(file, 16 * 1024 * 1024);
    expect((await evidence(candidate())).status).toBe(413);

    // A non-image file whose hash the run recorded is still not served as an image.
    const gif = Buffer.from("GIF89a fake image body");
    await writeFile(file, gif);
    const resultPath = join(ctx.paths.sourcingRuns, TEST_CASE, ctx.runId!, "result.json");
    const result = await readJson(resultPath);
    result.verified.find((e: { listingId: string }) => e.listingId === LISTING_A).imageEvidence.image.sha256 = sha256(gif);
    await writeFile(resultPath, JSON.stringify(result));
    expect((await evidence(candidate())).status).toBe(415);
  });

  it("is unavailable unless enabled locally, never in production, and only on loopback hosts", async () => {
    expect((await evidence(`reference/${TEST_CASE}`, { host: "192.168.1.20:3000" })).status).toBe(403);
    expect((await evidence(`reference/${TEST_CASE}`, { host: "evil.example" })).status).toBe(403);
    vi.stubEnv("NODE_ENV", "production");
    expect((await evidence(`reference/${TEST_CASE}`)).status).toBe(403);
    vi.stubEnv("NODE_ENV", "test");
    vi.stubEnv("VFSA_LOCAL_SOURCING_UI", "");
    const res = await evidence(`reference/${TEST_CASE}`);
    expect(res.status).toBe(403);
    expect((await res.json()).error).toBe("local_sourcing_disabled");
  });
});

describe("upload route", () => {
  const post = (body: BodyInit, init: Parameters<typeof localRequest>[1] = {}) => uploadsPOST(localRequest("/api/sourcing/uploads", { method: "POST", body, ...init }));
  const form = (bytes: Uint8Array, name = "photo.png", type = "image/png") => {
    const f = new FormData();
    f.append("file", new File([bytes as Uint8Array<ArrayBuffer>], name, { type }));
    return f;
  };

  it("stages a valid photo privately, awaiting image understanding, with a fresh id each time", async () => {
    const bytes = makePng(64, 48, 3);
    const res = await post(form(bytes, "../../My Ettrick photo?.png"));
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body).toMatchObject({ status: "awaiting_image_understanding", width: 64, height: 48, sha256: sha256(bytes) });
    const record = await readJson(join(ctx.paths.uploads, body.id, "upload.json"));
    expect(record).toMatchObject({ file: "image.png", originalName: "My Ettrick photo_.png", mimeType: "image/png" });
    expect(await readFile(join(ctx.paths.uploads, body.id, "image.png"))).toEqual(Buffer.from(bytes));

    const second = await (await post(form(bytes))).json();
    expect(second.id).not.toBe(body.id);
    expect((await readdir(ctx.paths.uploads)).sort()).toEqual([body.id, second.id].sort());
    expect((await evidence(`upload/${body.id}`)).status).toBe(200);
  });

  it("rejects wrong types, corrupt images, oversized files and cross-site submissions", async () => {
    expect((await post(form(Buffer.from("just text"), "x.png"))).status).toBe(422);
    const corrupt = await post(form(makePng(64, 48).subarray(0, 60)));
    expect(corrupt.status).toBe(422);
    expect((await corrupt.json()).error).toBe("corrupt");
    expect((await post(form(makeJpeg(40, 30), "ok.jpg", "image/jpeg"))).status).toBe(201);
    expect((await post(form(new Uint8Array(11 * 1024 * 1024)))).status).toBe(413);
    expect((await post(form(makePng(64, 48)), { origin: "https://evil.example" })).status).toBe(403);
    expect((await post(form(makePng(64, 48)), { origin: null })).status).toBe(403);
  });
});

describe("offline run route", () => {
  const post = (body: unknown, init: Parameters<typeof localRequest>[1] = {}) =>
    runsPOST(localRequest("/api/sourcing/runs", { method: "POST", body: JSON.stringify(body), headers: { "content-type": "application/json" }, ...init }));

  it("runs the existing orchestrator offline, reusing saved evidence, and reports the run", async () => {
    const res = await post({ caseId: TEST_CASE, mode: "offline-saved-evidence" });
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body).toMatchObject({ status: "partial", externalRequests: 0 });
    const runDir = join(ctx.paths.sourcingRuns, TEST_CASE, body.runId);
    const journal = await readJson(join(runDir, "run.json"));
    expect(journal.stages.verification.state).toBe("reused");
    expect(journal.authorization).toEqual({ externalDiscovery: "not_authorized", remoteImageDownload: "not_authorized", paidVerification: "not_authorized" });
    expect((await readdir(join(ctx.paths.sourcingRuns, TEST_CASE))).length).toBe(2); // the earlier run is kept

    const status = await runStatusGET(localRequest(`/api/sourcing/runs/${TEST_CASE}/${body.runId}`, { origin: null }), { params: Promise.resolve({ caseId: TEST_CASE, runId: body.runId }) });
    expect(await status.json()).toMatchObject({ status: "partial", resultAvailable: true });
  });

  it("prevents duplicate concurrent runs and rejects unsupported or cross-site requests", async () => {
    const [a, b] = await Promise.all([post({ caseId: TEST_CASE, mode: "offline-saved-evidence" }), post({ caseId: TEST_CASE, mode: "offline-saved-evidence" })]);
    expect([a.status, b.status].sort()).toEqual([201, 409]);
    expect((await post({ caseId: TEST_CASE, mode: "live" })).status).toBe(400);
    expect((await post({ caseId: "../x", mode: "offline-saved-evidence" })).status).toBe(400);
    expect((await post({ caseId: "unknown-case", mode: "offline-saved-evidence" })).status).toBe(404);
    expect((await post({ caseId: TEST_CASE, mode: "offline-saved-evidence" }, { origin: "https://evil.example" })).status).toBe(403);
    await rm(join(ctx.paths.candidates, `${TEST_CASE}.json`));
    expect((await post({ caseId: TEST_CASE, mode: "offline-saved-evidence" })).status).toBe(409); // no candidate set: not eligible
  });
});
