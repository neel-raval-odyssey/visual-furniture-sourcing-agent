/* eslint-disable @typescript-eslint/no-explicit-any -- fake SDK responses */
import OpenAI from "openai";
import { describe, expect, it, vi } from "vitest";
import type { ResponsesParseFn } from "../../understanding/openai/vision-client";
import { VisionModelError } from "../../understanding/openai/errors";
import { VISUAL_VERIFICATION_INSTRUCTIONS } from "./instructions";
import { OpenAIVisualVerificationClient } from "./verification-client";
import { fakeApiResponse, makePng, syntheticRawVerification } from "./test-fixtures";

const input = {
  reference: { bytes: new Uint8Array(makePng(32, 24, 1)), mimeType: "image/png" as const },
  candidate: { bytes: new Uint8Array(makePng(32, 24, 2)), mimeType: "image/png" as const },
  referenceObservations: "Category: bed",
};

function clientWith(impl: (...args: any[]) => Promise<unknown>) {
  const parse = vi.fn(impl);
  return { parse, client: new OpenAIVisualVerificationClient({ parse: parse as unknown as ResponsesParseFn }) };
}

async function categoryOf(promise: Promise<unknown>) {
  const error = await promise.catch((e: unknown) => e);
  expect(error).toBeInstanceOf(VisionModelError);
  return (error as VisionModelError).category;
}

describe("OpenAIVisualVerificationClient", () => {
  it("sends one pairwise request with the configured settings and no retries", async () => {
    const { parse, client } = clientWith(async () => fakeApiResponse(syntheticRawVerification()));
    const result = await client.comparePair(input);
    expect(parse).toHaveBeenCalledTimes(1);
    const [body, options] = parse.mock.calls[0];
    expect(body).toMatchObject({
      model: "gpt-6.1-sol",
      instructions: VISUAL_VERIFICATION_INSTRUCTIONS,
      reasoning: { effort: "medium" },
      max_output_tokens: 6000,
      tools: [],
      store: false,
    });
    expect(options).toEqual({ maxRetries: 0, timeout: 180_000 });
    const content = body.input[0].content;
    expect(content.map((c: { type: string }) => c.type)).toEqual(["input_text", "input_text", "input_image", "input_text", "input_image", "input_text"]);
    expect(content[1].text).toBe("REFERENCE image:");
    expect(content[2]).toMatchObject({ detail: "high", image_url: expect.stringMatching(/^data:image\/png;base64,/) });
    expect(content[3].text).toBe("CANDIDATE image:");
    expect(result).toMatchObject({ responseId: "resp_test_123", responseModel: "gpt-6.1-sol-2026-10-01", usage: { inputTokens: 2100, reasoningTokens: 400 } });
  });

  it("reports refusals, incomplete output, missing output and invalid output", async () => {
    const refusal = fakeApiResponse(null, { output: [{ type: "message", content: [{ type: "refusal", refusal: "no" }] }] });
    expect(await categoryOf(clientWith(async () => refusal).client.comparePair(input))).toBe("refusal");
    const truncated = fakeApiResponse(null, { status: "incomplete", incomplete_details: { reason: "max_output_tokens" } });
    const err = await clientWith(async () => truncated).client.comparePair(input).catch((e: VisionModelError) => e);
    expect(err).toMatchObject({ category: "incomplete", message: expect.stringContaining("max_output_tokens"), response: { responseId: "resp_test_123" } });
    expect(await categoryOf(clientWith(async () => fakeApiResponse(null, { output: [] })).client.comparePair(input))).toBe("missing_output");
    const unknownClass = fakeApiResponse({ ...syntheticRawVerification(), classification: "probably_same" as any });
    expect(await categoryOf(clientWith(async () => unknownClass).client.comparePair(input))).toBe("malformed_output");
    expect(await categoryOf(clientWith(async () => { throw new SyntaxError("bad json"); }).client.comparePair(input))).toBe("malformed_output");
  });

  it("classifies API errors without retrying or switching model", async () => {
    const headers = new Headers();
    const { parse, client } = clientWith(async () => {
      throw new OpenAI.AuthenticationError(401, { message: "bad key" }, "bad key", headers);
    });
    expect(await categoryOf(client.comparePair(input))).toBe("authentication");
    expect(parse).toHaveBeenCalledTimes(1);
    expect(parse.mock.calls[0][0].model).toBe("gpt-6.1-sol");
    const denied = clientWith(async () => {
      throw new OpenAI.PermissionDeniedError(403, { message: "no access" }, "no access", headers);
    });
    expect(await categoryOf(denied.client.comparePair(input))).toBe("permission");
    const limited = clientWith(async () => {
      throw new OpenAI.RateLimitError(429, { message: "slow down" }, "slow down", headers);
    });
    expect(await categoryOf(limited.client.comparePair(input))).toBe("rate_limit");
    expect(limited.parse).toHaveBeenCalledTimes(1);
  });
});
