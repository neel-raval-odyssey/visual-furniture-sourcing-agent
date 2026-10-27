import { join } from "node:path";
import { rm } from "node:fs/promises";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FurnitureFingerprint } from "@/lib/sourcing/domain";
import { analyzeUpload, getAnalysisStatus, preflightUpload, type AnalysisStatus } from "@/lib/sourcing/ui/analysis/analyze-upload";
import { reserveAttempt, saveAttempt } from "@/lib/sourcing/ui/analysis/attempts";
import { UNCERTAIN_TEXT } from "@/lib/sourcing/ui/analysis/present";
import { makeUiRepo } from "@/lib/sourcing/ui/test-fixtures";
import { stageUpload, type UploadRecord } from "@/lib/sourcing/ui/uploads";
import { SYNTHETIC_RAW_CHAIR, SYNTHETIC_RAW_NO_FURNITURE } from "@/lib/sourcing/understanding/openai/test-fixtures";
import { OpenAIVisionClient, type ResponsesParseFn } from "@/lib/sourcing/understanding/openai/vision-client";
import { loadSavedFingerprint } from "@/lib/sourcing/understanding/saved/saved-fingerprint";
import { makePng } from "@/lib/sourcing/verification/openai/test-fixtures";
import { UploadAnalysisView } from "./upload-analysis-view";

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }) }));

const ENV = { OPENAI_API_KEY: "sk-test-never-sent" };
const fetchSpy = vi.fn();
let ctx: Awaited<ReturnType<typeof makeUiRepo>>;
let upload: UploadRecord;

beforeEach(async () => {
  ctx = await makeUiRepo({ run: false });
  upload = await stageUpload(ctx.paths, makePng(64, 48, 3), "oak chair.png");
});
afterEach(async () => {
  expect(fetchSpy).not.toHaveBeenCalled(); // rendering any state never contacts a server
  vi.unstubAllGlobals();
  await rm(ctx.root, { recursive: true, force: true });
});

const text = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/&#x27;|&apos;/g, "'").replace(/&quot;/g, '"').replace(/\s+/g, " ");
/** Content visible without opening a disclosure. The dialog body is kept: it is what the user reviews. */
function primary(html: string) {
  const inner = /<details[^>]*>(?:(?!<details)[\s\S])*?<\/details>/;
  while (inner.test(html)) html = html.replace(inner, "");
  return text(html);
}

function render(status: AnalysisStatus, fingerprint: FurnitureFingerprint | null = null) {
  vi.stubGlobal("fetch", fetchSpy);
  return renderToStaticMarkup(<UploadAnalysisView upload={upload} status={status} fingerprint={fingerprint} example={null} />);
}

/** A real attempt journal in the given state (as left by a running or interrupted request). */
async function journalIn(state: "sending") {
  const pre = await preflightUpload(ctx.paths, upload.id, ENV);
  if (!pre.ok) throw new Error(pre.message);
  const r = await reserveAttempt(ctx.paths, { uploadId: upload.id, attemptKey: pre.attemptKey, caseId: pre.caseId, referenceId: pre.referenceId, image: { sha256: upload.sha256, mimeType: upload.mimeType, bytes: upload.bytes, width: upload.width, height: upload.height }, request: pre.request });
  if (!r.ok) throw new Error(r.reason);
  return saveAttempt(ctx.paths, { ...r.attempt, state, sendStartedAt: new Date().toISOString() });
}

async function analyzeWith(raw: unknown) {
  const parse = vi.fn(async () => ({ id: "resp_view_test", model: "gpt-6-luna", status: "completed", output: [], output_parsed: raw, usage: { input_tokens: 1000, output_tokens: 300, total_tokens: 1300 } }));
  const pre = await preflightUpload(ctx.paths, upload.id, ENV);
  if (!pre.ok) throw new Error(pre.message);
  await analyzeUpload(ctx.paths, upload.id, pre.attemptKey, { env: ENV, createVision: (_k, s) => new OpenAIVisionClient({ parse: parse as unknown as ResponsesParseFn, model: s.model }) });
  return getAnalysisStatus(ctx.paths, upload.id, ENV);
}

const TECHNICAL = /\b(fingerprint|tokens?|sha-?256|resp_|upl-|instructions? version|orchestrat\w*|SigLIP|Sol)\b/i;

describe("upload page states", () => {
  it("before analysis: the photo, a clear action, and a confirmation that explains the paid request", async () => {
    const status = await getAnalysisStatus(ctx.paths, upload.id, ENV);
    expect(status.state).toBe("ready");
    const html = render(status);
    const page = primary(html);
    expect(page).toContain("Photo saved successfully");
    expect(page).toContain("AI can identify the furniture's shape, materials, colours and distinctive design details.");
    expect(page).toContain("oak chair.png");
    expect(page).toContain("Analyze this photo");
    expect(html).toContain(`src="/api/sourcing/evidence/upload/${upload.id}"`);
    // The dialog (closed until the user opens it).
    expect(html).toMatch(/<dialog[^>]*aria-labelledby="analyze-title"/);
    for (const s of ["sent to OpenAI", "GPT-6 Luna", "gpt-6-luna", "paid API request", "isn't known in advance", "saved privately", "won't search Alibaba", "no product matches are created", "Cancel", "Confirm and analyze"]) expect(page).toContain(s);
    expect(page).not.toMatch(/has been analyzed|\$\d|maximum charge/i);
  });

  it("explains a missing API key instead of offering the action", () => {
    const html = primary(render({ state: "unavailable", problem: "api_key_missing", message: "Analysis isn't set up on this computer: OPENAI_API_KEY is not configured on the server.", previous: null }));
    expect(html).toContain("apps/web/.env.local");
    expect(html).not.toContain("Analyze this photo");
  });

  it("while analyzing: a truthful loading state with no progress figures or product search", async () => {
    const html = primary(render({ state: "analyzing", attempt: await journalIn("sending") }));
    expect(html).toContain("Analyzing furniture details");
    expect(html).toContain("Examining the visible shape, structure and distinctive design features.");
    expect(html).not.toMatch(/\d+%/);
    expect(html).not.toContain("Analyze this photo");
  });

  it("after analysis: plain-English furniture details from the saved fingerprint and the next step, with no products", async () => {
    const status = await analyzeWith(SYNTHETIC_RAW_CHAIR);
    expect(status.state).toBe("analyzed");
    if (status.state !== "analyzed") return;
    const { fingerprint } = await loadSavedFingerprint(join(ctx.paths.predictions, `${status.attempt.caseId}.json`), status.attempt.caseId);
    const html = render(status, fingerprint);
    const page = primary(html);
    expect(page).toContain("Your furniture has been analyzed");
    expect(page).toContain("Finding similar products is the next step.");
    expect(page).toContain("Ready for product discovery");
    expect(page).toMatch(/Chair · Dining chair/);
    expect(page).toMatch(/Backrest curve ?: deep continuous curve/);
    expect(page).toMatch(/Leg count ?: 4/);
    expect(page).toMatch(/Frame material ?: solid wood likely/);
    expect(page).toMatch(/Not visible in this photo .*Rear legs not visible Hidden behind the seat\./);
    expect(page).toContain("Advanced details");
    expect(html).toContain(`href="/sourcing/references/${status.attempt.caseId}"`);
    expect(page).not.toMatch(TECHNICAL);
    expect(page).not.toMatch(/similar alternative|close design|Alibaba listing|\/100|supplier/i);
    const full = text(html);
    expect(full).toContain("resp_view_test");
    expect(full).toMatch(/input 1000, output 300, total 1300 tokens/);
  });

  it("no furniture: says so and saves no reference", async () => {
    const status = await analyzeWith(SYNTHETIC_RAW_NO_FURNITURE);
    expect(status.state).toBe("not_identified");
    const page = primary(render(status));
    expect(page).toContain("We couldn't identify a clear furniture item in this photo.");
    expect(page).toContain("Nothing was saved as a furniture reference.");
    expect(page).not.toMatch(/has been analyzed|Ready for product discovery|Chair/);
  });

  it("uncertain outcome: warns about a possible charge and offers no instant retry", async () => {
    const attempt = await journalIn("sending");
    const status = await getAnalysisStatus(ctx.paths, upload.id, ENV, Date.now() + 10 * 60_000);
    expect(status).toMatchObject({ state: "uncertain", attempt: { attempt: attempt.attempt } });
    const page = primary(render(status));
    expect(page).toContain(UNCERTAIN_TEXT);
    expect(page).toContain("may be charged again");
    expect(page).not.toMatch(/Analyze this photo|Retry|Try again now/);
  });
});
