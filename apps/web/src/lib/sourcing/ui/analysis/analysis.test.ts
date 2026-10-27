import OpenAI from "openai";
import { readdir, readFile, rm, symlink, truncate, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GET as statusGET, POST as analysisPOST } from "../../../../app/api/sourcing/uploads/[uploadId]/analysis/route";
import { POST as uploadsPOST } from "../../../../app/api/sourcing/uploads/route";
import { runRecordSchema } from "../../evaluation/run-record";
import { resolveReferenceImage } from "../../shortlisting/evidence";
import { sha256, TEST_CASE } from "../../shortlisting/test-fixtures";
import { FURNITURE_UNDERSTANDING_INSTRUCTIONS, FURNITURE_UNDERSTANDING_INSTRUCTIONS_VERSION } from "../../understanding/openai/instructions";
import { SYNTHETIC_RAW_CHAIR, SYNTHETIC_RAW_NO_FURNITURE } from "../../understanding/openai/test-fixtures";
import { OpenAIVisionClient, type ResponsesParseFn } from "../../understanding/openai/vision-client";
import { loadSavedFingerprint } from "../../understanding/saved/saved-fingerprint";
import { makeJpeg, makePng } from "../../verification/openai/test-fixtures";
import { getReference, listReferences } from "../data";
import { localRequest, makeUiRepo } from "../test-fixtures";
import { stageUpload, type UploadRecord } from "../uploads";
import { analyzeUpload, finishPendingRegistration, getAnalysisStatus, preflightUpload } from "./analyze-upload";
import { attemptKeyFor, caseIdForUpload, listAttempts, reserveAttempt, saveAttempt } from "./attempts";
import { addImageMapEntry } from "./register";

/* eslint-disable @typescript-eslint/no-explicit-any -- fake SDK responses */

const ENV = { OPENAI_API_KEY: "sk-test-never-sent" };
const fetchSpy = vi.fn();
let ctx: Awaited<ReturnType<typeof makeUiRepo>>;
let upload: UploadRecord;
let imageBytes: Buffer;

beforeEach(async () => {
  ctx = await makeUiRepo({ run: false });
  imageBytes = makePng(64, 48, 7);
  upload = await stageUpload(ctx.paths, imageBytes, "living room chair.png");
  vi.stubGlobal("fetch", fetchSpy); // no OpenAI, Apify, Alibaba or image request may happen
});
afterEach(async () => {
  expect(fetchSpy).not.toHaveBeenCalled();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  await rm(ctx.root, { recursive: true, force: true });
});

function lunaResponse(raw: unknown = SYNTHETIC_RAW_CHAIR, overrides: Record<string, unknown> = {}) {
  return {
    id: "resp_synthetic_upload",
    model: "gpt-6-luna",
    status: "completed",
    output: [{ type: "message", content: [{ type: "output_text", text: "{}", parsed: raw }] }],
    output_parsed: raw,
    usage: { input_tokens: 1300, output_tokens: 410, total_tokens: 1710, output_tokens_details: { reasoning_tokens: 90 } },
    ...overrides,
  };
}

/** A fake SDK `responses.parse`, wrapped by the real OpenAIVisionClient. */
function fakeLuna(impl: (...args: any[]) => unknown = async () => lunaResponse()) {
  const parse = vi.fn(impl);
  const createVision = vi.fn((_key: string, settings: { model: string }) => new OpenAIVisionClient({ parse: parse as unknown as ResponsesParseFn, model: settings.model }));
  return { parse, createVision };
}

const keyFor = () => attemptKeyFor(upload.id, upload.sha256, { model: "gpt-6-luna", instructionsVersion: FURNITURE_UNDERSTANDING_INSTRUCTIONS_VERSION, imageDetail: "high", reasoningEffort: "low", maxOutputTokens: 4096, timeoutMs: 60_000 });
const caseId = () => caseIdForUpload(upload.id);
const imagesMap = async () => JSON.parse(await readFile(ctx.paths.imagesMap, "utf8"));
const uploadDir = () => join(ctx.paths.uploads, upload.id);

describe("preflight", () => {
  it("accepts a valid staged photo without any network request", async () => {
    const pre = await preflightUpload(ctx.paths, upload.id, ENV);
    expect(pre).toMatchObject({ ok: true, caseId: caseId(), attemptKey: keyFor(), request: { model: "gpt-6-luna", instructionsVersion: FURNITURE_UNDERSTANDING_INSTRUCTIONS_VERSION } });
    expect(caseId()).toMatch(/^[a-z0-9][a-z0-9-]*$/);
  });

  it("rejects unknown, missing, changed, symlinked, mislabelled, oversized, corrupt and resized photos, and a missing key", async () => {
    const problem = async (env = ENV) => {
      const pre = await preflightUpload(ctx.paths, upload.id, env);
      return pre.ok ? "ok" : pre.problem;
    };
    expect((await preflightUpload(ctx.paths, "upl-2026-01-01T00-00-00Z-00000000", ENV)).ok).toBe(false);
    expect((await preflightUpload(ctx.paths, "../../etc", ENV)).ok).toBe(false);
    expect(await problem({} as typeof ENV)).toBe("api_key_missing");

    const file = join(uploadDir(), upload.file);
    const recordPath = join(uploadDir(), "upload.json");
    const record = JSON.parse(await readFile(recordPath, "utf8"));
    const setRecord = (patch: Record<string, unknown>) => writeFile(recordPath, JSON.stringify({ ...record, ...patch }));

    await writeFile(file, makePng(64, 48, 99));
    expect(await problem()).toBe("changed");
    await rm(file);
    expect(await problem()).toBe("missing_image");
    await writeFile(join(ctx.root, "elsewhere.png"), imageBytes);
    await symlink(join(ctx.root, "elsewhere.png"), file);
    expect(await problem()).toBe("invalid_path");
    await rm(file);
    await writeFile(file, imageBytes);
    expect(await problem()).toBe("ok");

    await setRecord({ mimeType: "image/jpeg" });
    expect(await problem()).toBe("unsupported_format");
    await setRecord({ width: 65 });
    expect(await problem()).toBe("dimensions");

    const corrupt = imageBytes.subarray(0, 60);
    await writeFile(file, corrupt);
    await setRecord({ sha256: sha256(corrupt), bytes: corrupt.length });
    expect(await problem()).toBe("corrupt");

    await writeFile(file, imageBytes);
    await truncate(file, 11 * 1024 * 1024);
    await setRecord({ sha256: sha256(await readFile(file)), bytes: 11 * 1024 * 1024 });
    expect(await problem()).toBe("too_large");
  });
});

describe("one confirmed request", () => {
  it("sends exactly one Luna request with the established settings, and saves a standard, loadable reference", async () => {
    const luna = fakeLuna();
    const before = await imagesMap();
    const out = await analyzeUpload(ctx.paths, upload.id, keyFor(), { env: ENV, createVision: luna.createVision });
    expect(out.ok).toBe(true);
    expect(luna.parse).toHaveBeenCalledTimes(1);

    const [body, options] = luna.parse.mock.calls[0];
    expect(body.model).toBe("gpt-6-luna");
    expect(body.instructions).toBe(FURNITURE_UNDERSTANDING_INSTRUCTIONS);
    expect(body.store).toBe(false);
    expect(body.tools).toEqual([]);
    expect(body.max_output_tokens).toBe(4096);
    expect(body.reasoning).toEqual({ effort: "low" });
    const image = body.input[0].content.find((c: any) => c.type === "input_image");
    expect(image).toEqual({ type: "input_image", detail: "high", image_url: `data:image/png;base64,${imageBytes.toString("base64")}` });
    expect(options).toEqual({ maxRetries: 0, timeout: 60_000 });

    // The standard run record, read by the same loader as every other reference.
    const saved = await loadSavedFingerprint(join(ctx.paths.predictions, `${caseId()}.json`), caseId());
    expect(saved.record).toMatchObject({ caseId: caseId(), dataSource: "live", image: { sha256: upload.sha256, mimeType: "image/png", bytes: imageBytes.length }, request: { model: "gpt-6-luna", instructionsVersion: FURNITURE_UNDERSTANDING_INSTRUCTIONS_VERSION } });
    expect(saved.fingerprint.source).toEqual({ kind: "model", dataSource: "live", modelId: "gpt-6-luna" });
    expect(saved.record.response).toMatchObject({ responseId: "resp_synthetic_upload", usage: { inputTokens: 1300, outputTokens: 410, totalTokens: 1710, reasoningTokens: 90 } });

    // Mapping: every existing entry kept, the new one relative to the staged photo (not copied).
    const after = await imagesMap();
    expect(after.images).toEqual({ ...before.images, [caseId()]: `uploads/${upload.id}/${upload.file}` });
    expect((await resolveReferenceImage(ctx.paths.imagesMap, saved)).sha256).toBe(upload.sha256);
    expect(await readdir(uploadDir())).toEqual(expect.arrayContaining(["image.png", "upload.json", "analysis"]));

    // The journal ties upload → attempt → reference → record.
    const [attempt] = (await listAttempts(ctx.paths, upload.id)).attempts;
    expect(attempt).toMatchObject({ state: "analyzed", attempt: 1, caseId: caseId(), attemptKey: keyFor(), predictionFile: `evals/local/predictions/${caseId()}.json`, response: { responseId: "resp_synthetic_upload" } });
    expect(JSON.stringify(attempt)).not.toMatch(/sk-test|base64/);
    expect(runRecordSchema.parse(JSON.parse(await readFile(join(uploadDir(), attempt.recordFile!), "utf8"))).caseId).toBe(caseId());
  });

  it("never sends a second request: repeats, concurrent confirmations and restarts are refused", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const luna = fakeLuna(async () => {
      await gate;
      return lunaResponse();
    });
    const run = () => analyzeUpload(ctx.paths, upload.id, keyFor(), { env: ENV, createVision: luna.createVision });
    const first = run();
    await vi.waitFor(() => expect(luna.parse).toHaveBeenCalledTimes(1));
    expect(await getAnalysisStatus(ctx.paths, upload.id, ENV)).toMatchObject({ state: "analyzing" });
    const during = await Promise.all([run(), run()]);
    expect(during.map((o) => (o.ok ? "ok" : o.code))).toEqual(["in_progress", "in_progress"]);
    release();
    expect((await first).ok).toBe(true);
    const again = await run();
    expect(again).toMatchObject({ ok: false, code: "already_attempted" });
    expect(luna.parse).toHaveBeenCalledTimes(1);
  });

  it("treats a request lost to a restart as uncertain and does not resend it", async () => {
    // What a crashed or restarted server leaves behind: only the durable journal, marked "sending".
    const pre = await preflightUpload(ctx.paths, upload.id, ENV);
    if (!pre.ok) throw new Error(pre.message);
    const reserved = await reserveAttempt(ctx.paths, { uploadId: upload.id, attemptKey: pre.attemptKey, caseId: pre.caseId, referenceId: pre.referenceId, image: { sha256: upload.sha256, mimeType: upload.mimeType, bytes: upload.bytes, width: upload.width, height: upload.height }, request: pre.request });
    if (!reserved.ok) throw new Error(reserved.reason);
    await saveAttempt(ctx.paths, { ...reserved.attempt, state: "sending", sendStartedAt: new Date().toISOString() });

    const luna = fakeLuna();
    const run = (now: number) => analyzeUpload(ctx.paths, upload.id, keyFor(), { env: ENV, createVision: luna.createVision, now: () => new Date(now) });
    expect(await getAnalysisStatus(ctx.paths, upload.id, ENV)).toMatchObject({ state: "analyzing" });
    expect(await run(Date.now())).toMatchObject({ ok: false, code: "in_progress" });
    const later = Date.now() + 10 * 60_000; // past the request timeout: the outcome is unknown
    expect(await getAnalysisStatus(ctx.paths, upload.id, ENV, later)).toMatchObject({ state: "uncertain" });
    expect(await run(later)).toMatchObject({ ok: false, code: "already_attempted" });
    expect(luna.parse).not.toHaveBeenCalled();
  });

  it("refuses a confirmation for a different photo or configuration", async () => {
    const luna = fakeLuna();
    const out = await analyzeUpload(ctx.paths, upload.id, "0".repeat(64), { env: ENV, createVision: luna.createVision });
    expect(out).toMatchObject({ ok: false, code: "confirmation_mismatch" });
    expect(luna.parse).not.toHaveBeenCalled();
    expect((await listAttempts(ctx.paths, upload.id)).attempts).toHaveLength(0);
  });

  it("records a failure before sending as not sent, and allows a new confirmed attempt", async () => {
    const broken = vi.fn(() => {
      throw new Error("client setup failed");
    });
    const out = await analyzeUpload(ctx.paths, upload.id, keyFor(), { env: ENV, createVision: broken });
    expect(out).toMatchObject({ ok: false, code: "not_sent", attempt: { state: "not_sent", sendStartedAt: null } });
    const luna = fakeLuna();
    expect((await analyzeUpload(ctx.paths, upload.id, keyFor(), { env: ENV, createVision: luna.createVision })).ok).toBe(true);
    expect((await listAttempts(ctx.paths, upload.id)).attempts.map((a) => a.state)).toEqual(["not_sent", "analyzed"]);
    expect(luna.parse).toHaveBeenCalledTimes(1);
  });
});

describe("outcomes without a fingerprint", () => {
  const outcomes: [string, () => unknown, string, string | null][] = [
    ["no furniture", async () => lunaResponse(SYNTHETIC_RAW_NO_FURNITURE), "not_identified", null],
    ["a refusal", async () => lunaResponse(null, { output: [{ type: "message", content: [{ type: "refusal", refusal: "No." }] }] }), "failed", "refusal"],
    ["truncated output", async () => lunaResponse(null, { status: "incomplete", incomplete_details: { reason: "max_output_tokens" }, output_parsed: null }), "failed", "incomplete"],
    ["an invalid structure", async () => lunaResponse({ outcome: "furniture_identified" }), "failed", "malformed_output"],
    ["a rejected key", async () => { throw new OpenAI.AuthenticationError(401, {}, "Incorrect API key", new Headers()); }, "failed", "authentication"],
    ["a timeout", async () => { throw new OpenAI.APIConnectionTimeoutError(); }, "uncertain", "timeout"],
    ["a dropped connection", async () => { throw new OpenAI.APIConnectionError({ message: "ECONNRESET" }); }, "uncertain", "network"],
  ];
  it.each(outcomes)("records %s truthfully, saves no reference and never retries", async (_name, impl, state, category) => {
    const luna = fakeLuna(impl);
    const before = await imagesMap();
    await analyzeUpload(ctx.paths, upload.id, keyFor(), { env: ENV, createVision: luna.createVision });
    const [attempt] = (await listAttempts(ctx.paths, upload.id)).attempts;
    expect(attempt.state).toBe(state);
    expect(attempt.outcome?.errorCategory ?? null).toBe(category);
    expect(await getAnalysisStatus(ctx.paths, upload.id, ENV)).toMatchObject({ state });
    await expect(readFile(join(ctx.paths.predictions, `${caseId()}.json`))).rejects.toThrow();
    expect(await imagesMap()).toEqual(before);
    expect((await analyzeUpload(ctx.paths, upload.id, keyFor(), { env: ENV, createVision: luna.createVision })).ok).toBe(false);
    expect(luna.parse).toHaveBeenCalledTimes(1);
  });
});

describe("reference registration", () => {
  it("never overwrites an existing reference with the same identity", async () => {
    await writeFile(join(ctx.paths.predictions, `${caseId()}.json`), "{}");
    const luna = fakeLuna();
    expect(await analyzeUpload(ctx.paths, upload.id, keyFor(), { env: ENV, createVision: luna.createVision })).toMatchObject({ ok: false, code: "case_collision" });
    expect(luna.parse).not.toHaveBeenCalled();
    expect(await readFile(join(ctx.paths.predictions, `${caseId()}.json`), "utf8")).toBe("{}");
  });

  it("keeps every entry when many mapping updates run at once", async () => {
    const before = await imagesMap();
    await Promise.all(Array.from({ length: 12 }, (_, i) => addImageMapEntry(ctx.paths.imagesMap, `upl-concurrent-${i}`, `uploads/x${i}/image.png`)));
    const after = await imagesMap();
    expect(Object.keys(after.images)).toHaveLength(Object.keys(before.images).length + 12);
    expect(after.images[TEST_CASE]).toBe(before.images[TEST_CASE]);
    await expect(addImageMapEntry(ctx.paths.imagesMap, TEST_CASE, "uploads/other.png")).rejects.toThrow(/different photo/);
  });

  it("keeps a paid result when registration fails, and finishes it later without a new request", async () => {
    const original = await readFile(ctx.paths.imagesMap, "utf8");
    await writeFile(ctx.paths.imagesMap, "{ broken");
    const luna = fakeLuna();
    const out = await analyzeUpload(ctx.paths, upload.id, keyFor(), { env: ENV, createVision: luna.createVision });
    expect(out).toMatchObject({ ok: false, code: "image_map_invalid", attempt: { state: "registration_pending" } });
    expect(await readFile(ctx.paths.imagesMap, "utf8")).toBe("{ broken"); // left unchanged
    expect(await getAnalysisStatus(ctx.paths, upload.id, ENV)).toMatchObject({ state: "registration_pending" });

    await writeFile(ctx.paths.imagesMap, original);
    expect((await finishPendingRegistration(ctx.paths, upload.id)).ok).toBe(true);
    expect(luna.parse).toHaveBeenCalledTimes(1);
    expect((await imagesMap()).images[caseId()]).toBe(`uploads/${upload.id}/image.png`);
  });

  it("refuses to proceed past an unreadable attempt journal", async () => {
    const luna = fakeLuna();
    await analyzeUpload(ctx.paths, upload.id, keyFor(), { env: ENV, createVision: fakeLuna(async () => { throw new OpenAI.APIConnectionTimeoutError(); }).createVision });
    const [a] = (await listAttempts(ctx.paths, upload.id)).attempts;
    await saveAttempt(ctx.paths, { ...a, state: "not_sent" });
    await writeFile(join(uploadDir(), "analysis", "attempt-1.json"), "{ corrupted");
    expect(await getAnalysisStatus(ctx.paths, upload.id, ENV)).toMatchObject({ state: "blocked" });
    expect((await analyzeUpload(ctx.paths, upload.id, keyFor(), { env: ENV, createVision: luna.createVision })).ok).toBe(false);
    expect(luna.parse).not.toHaveBeenCalled();
  });
});

describe("analysis route", () => {
  const post = (body: unknown, init: Parameters<typeof localRequest>[1] = {}, id = upload.id) =>
    analysisPOST(localRequest(`/api/sourcing/uploads/${id}/analysis`, { method: "POST", body: JSON.stringify(body), headers: { "content-type": "application/json" }, ...init }), { params: Promise.resolve({ uploadId: id }) });
  const get = (init: Parameters<typeof localRequest>[1] = {}, id = upload.id) =>
    statusGET(localRequest(`/api/sourcing/uploads/${id}/analysis`, { origin: null, ...init }), { params: Promise.resolve({ uploadId: id }) });

  beforeEach(() => {
    vi.stubEnv("VFSA_LOCAL_SOURCING_UI", "1");
    vi.stubEnv("VFSA_REPO_ROOT", ctx.root);
    vi.stubEnv("OPENAI_API_KEY", ENV.OPENAI_API_KEY);
  });

  function spyLuna(impl?: (...args: any[]) => unknown) {
    const luna = fakeLuna(impl);
    vi.spyOn(OpenAIVisionClient, "fromApiKey").mockImplementation((_key, model) => luna.createVision(_key, { model: model ?? "gpt-6-luna" }));
    return luna;
  }

  it("is local-only, same-origin for actions, and needs an explicit confirmation", async () => {
    const luna = spyLuna();
    expect((await get({ host: "192.168.1.5:3000" })).status).toBe(403);
    expect((await post({ action: "analyze", attemptKey: keyFor() }, { origin: "https://evil.example" })).status).toBe(403);
    expect((await post({ action: "analyze", attemptKey: keyFor() }, { origin: null })).status).toBe(403);
    expect((await post({ action: "analyze", attemptKey: keyFor() }, { host: "evil.example" })).status).toBe(403);
    expect((await post({ action: "analyze" })).status).toBe(400);
    expect((await post({ action: "analyze", attemptKey: keyFor(), model: "gpt-6.1-sol" })).status).toBe(200); // a model in the body is ignored
    expect(luna.parse.mock.calls[0][0].model).toBe("gpt-6-luna");
    expect((await post({ action: "analyze", attemptKey: keyFor() }, {}, "../../etc")).status).toBe(400);
    vi.stubEnv("NODE_ENV", "production");
    expect((await post({ action: "analyze", attemptKey: keyFor() })).status).toBe(403);
    vi.stubEnv("NODE_ENV", "test");
    vi.stubEnv("VFSA_LOCAL_SOURCING_UI", "");
    expect((await get()).status).toBe(403);
    expect(luna.parse).toHaveBeenCalledTimes(1);
  });

  it("reports a missing API key as unavailable without contacting anyone", async () => {
    const luna = spyLuna();
    vi.stubEnv("OPENAI_API_KEY", "");
    expect(await (await get()).json()).toMatchObject({ state: "unavailable", problem: "api_key_missing" });
    expect((await post({ action: "analyze", attemptKey: keyFor() })).status).toBe(503);
    expect(luna.parse).not.toHaveBeenCalled();
  });

  it("status reads never send requests and expose no secrets or paths", async () => {
    const luna = spyLuna();
    for (let i = 0; i < 3; i++) {
      const body = await (await get()).json();
      expect(body).toEqual({ state: "ready", attemptKey: keyFor(), model: "gpt-6-luna" });
    }
    await post({ action: "analyze", attemptKey: keyFor() });
    const text = await (await get()).text();
    expect(text).not.toMatch(/sk-test|evals\/local|Users|base64/);
    expect(JSON.parse(text)).toMatchObject({ state: "analyzed", attempt: { attempt: 1, state: "analyzed" } });
    expect(luna.parse).toHaveBeenCalledTimes(1);
  });

  it("end to end: upload → preflight → one confirmed (mocked) request → saved, discoverable reference, nothing else", async () => {
    const luna = spyLuna();
    const form = new FormData();
    form.append("file", new File([makeJpeg(80, 60) as Uint8Array<ArrayBuffer>], "my sideboard.jpg", { type: "image/jpeg" }));
    const staged = await (await uploadsPOST(localRequest("/api/sourcing/uploads", { method: "POST", body: form }))).json();
    const status = await (await get({}, staged.id)).json();
    expect(status.state).toBe("ready");
    expect(luna.parse).not.toHaveBeenCalled();

    const res = await post({ action: "analyze", attemptKey: status.attemptKey }, {}, staged.id);
    expect(res.status).toBe(200);
    expect(luna.parse).toHaveBeenCalledTimes(1);
    expect(await (await get({}, staged.id)).json()).toMatchObject({ state: "analyzed" });

    const newCase = caseIdForUpload(staged.id);
    const refs = await listReferences(ctx.paths);
    const ref = refs.find((r) => r.caseId === newCase);
    expect(ref).toMatchObject({ understanding: "furniture_identified", readiness: "no_candidates", category: "chair", photo: { available: true }, runs: [], savedAssessments: 0 });
    const detail = await getReference(ctx.paths, newCase);
    expect(detail?.fingerprint).not.toBeNull();
    // No candidates, shortlists, verifications or sourcing runs were made for it.
    for (const dir of [ctx.paths.candidates, ctx.paths.shortlists, ctx.paths.verifications, ctx.paths.sourcingRuns]) {
      const names = await readdir(dir).catch(() => [] as string[]);
      expect(names.filter((n) => n.includes(newCase))).toEqual([]);
    }
    expect((await post({ action: "analyze", attemptKey: status.attemptKey }, {}, staged.id)).status).toBe(409);
    expect(luna.parse).toHaveBeenCalledTimes(1);
  });
});
