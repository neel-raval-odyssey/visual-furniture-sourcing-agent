import { vi } from "vitest";
import type { EmbedRequest } from "../../shortlisting/protocol";
import type { ImageSimilarityRunner } from "../../shortlisting/embedding-client";
import { COMMIT, fakeResponse } from "../../shortlisting/test-fixtures";
import { SYNTHETIC_RAW_CHAIR } from "../../understanding/openai/test-fixtures";
import { OpenAIVisionClient, type ResponsesParseFn } from "../../understanding/openai/vision-client";
import { makePng } from "../../verification/openai/test-fixtures";
import { analyzeUpload, preflightUpload } from "../analysis/analyze-upload";
import { caseIdForUpload } from "../analysis/attempts";
import type { Paths } from "../data";
import { stageUpload } from "../uploads";
import type { EntryInput } from "./intake";

/**
 * TEST-ONLY: a newly uploaded photo analysed through the real P1-007 path with
 * a fake Luna response (no network), giving a genuine-shaped reference with no
 * candidates, exactly what a new photo looks like before intake.
 */
export async function analysedUploadReference(paths: Paths) {
  const upload = await stageUpload(paths, makePng(80, 60, 11), "[TEST] nesting tables.png");
  const env = { OPENAI_API_KEY: "sk-test-never-sent" };
  const pre = await preflightUpload(paths, upload.id, env);
  if (!pre.ok) throw new Error(pre.message);
  const parse = vi.fn(async () => ({ id: "resp_test_intake", model: "gpt-6-luna", status: "completed", output: [], output_parsed: SYNTHETIC_RAW_CHAIR, usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } }));
  const out = await analyzeUpload(paths, upload.id, pre.attemptKey, { env, createVision: (_k, s) => new OpenAIVisionClient({ parse: parse as unknown as ResponsesParseFn, model: s.model }) });
  if (!out.ok) throw new Error(out.message);
  return { upload, caseId: caseIdForUpload(upload.id) };
}

/** A synthetic product as an operator would type it ([TEST] titles; product ids no real listing uses). */
export const product = (n: number, extra: Partial<EntryInput> = {}): EntryInput => ({
  listingUrl: `https://www.alibaba.com/product-detail/TEST-Nesting-Table-${n}_10000000000${n}.html`,
  title: `[TEST] Nesting table ${n}`,
  supplierName: "[TEST] Supplier One",
  supplierProfileUrl: "https://testsupplierone.en.alibaba.com/",
  priceMin: "120",
  priceMax: "150.5",
  currency: "usd",
  priceUnit: "set",
  moqQuantity: "2",
  moqUnit: "sets",
  foundWith: "alibaba_image_search",
  queryUsed: null,
  notes: null,
  ...extra,
});

export const productImage = (shade: number) => ({ bytes: new Uint8Array(makePng(40, 30, shade)), name: `[TEST] product ${shade}.png` });

/** A local SigLIP stand-in: scores every group that has an image, in request order, highest first. */
export function fakeSiglip(): ImageSimilarityRunner & { requests: EmbedRequest[] } {
  const requests: EmbedRequest[] = [];
  return {
    requests,
    async embed(request) {
      requests.push(structuredClone(request));
      const scores = Object.fromEntries(request.groups.filter((g) => g.images.length).map((g, i) => [g.id, Number((0.9 - i * 0.05).toFixed(4))]));
      return fakeResponse(request, scores);
    },
    async environment(model) {
      return { status: "ok", runtime: { python: "test", torch: "test", transformers: "test" }, imageFormats: { avif: true }, device: { auto: "cpu", reason: "test" }, model: { id: model.id, cached: true, revision: COMMIT, reason: "test" } };
    },
  };
}
