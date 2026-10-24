import OpenAI from "openai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { TEST_JPEG, TEST_PNG } from "../../image-input/test-fixtures";
import { VisionModelError, type VisionModelErrorCategory } from "./errors";
import { FURNITURE_UNDERSTANDING_INSTRUCTIONS } from "./instructions";
import { RAW_VISION_FORMAT_NAME } from "./raw-response";
import { SYNTHETIC_RAW_CHAIR } from "./test-fixtures";
import { createOpenAIClient, OpenAIVisionClient, type ResponsesParseFn } from "./vision-client";

/* eslint-disable @typescript-eslint/no-explicit-any -- fake SDK responses */

const jpeg = { bytes: TEST_JPEG, mimeType: "image/jpeg" as const };

function fakeResponse(overrides: Record<string, unknown> = {}) {
  return {
    id: "resp_synthetic_1",
    model: "gpt-6-luna",
    status: "completed",
    output: [
      { type: "message", content: [{ type: "output_text", text: "{}", parsed: SYNTHETIC_RAW_CHAIR }] },
    ],
    output_parsed: SYNTHETIC_RAW_CHAIR,
    usage: { input_tokens: 1200, output_tokens: 300, total_tokens: 1500, output_tokens_details: { reasoning_tokens: 80 } },
    ...overrides,
  };
}

function clientWith(impl: (...args: any[]) => unknown, model?: string) {
  const parse = vi.fn(impl);
  return { parse, client: new OpenAIVisionClient({ parse: parse as unknown as ResponsesParseFn, model }) };
}

const headers = new Headers({ "x-request-id": "req_synthetic" });

async function expectCategory(client: OpenAIVisionClient, category: VisionModelErrorCategory) {
  const error = await client.analyzeImage(jpeg).catch((e: unknown) => e);
  expect(error).toBeInstanceOf(VisionModelError);
  expect((error as VisionModelError).category).toBe(category);
  return error as VisionModelError;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("OpenAIVisionClient request", () => {
  it("sends one Responses API request with the expected configuration", async () => {
    const { parse, client } = clientWith(async () => fakeResponse());
    await client.analyzeImage(jpeg);

    expect(parse).toHaveBeenCalledTimes(1);
    const [body, options] = parse.mock.calls[0];
    expect(body.model).toBe("gpt-6-luna");
    expect(body.instructions).toBe(FURNITURE_UNDERSTANDING_INSTRUCTIONS);
    expect(body.store).toBe(false);
    expect(body.tools).toEqual([]);
    expect(body.reasoning).toEqual({ effort: "low" });
    expect(body.max_output_tokens).toBe(4096);
    expect(body.text.format).toMatchObject({ type: "json_schema", name: RAW_VISION_FORMAT_NAME, strict: true });
    expect(options).toEqual({ maxRetries: 0, timeout: 60_000 });
  });

  it("sends the image as a base64 data URL with the detected MIME type and high detail", async () => {
    const { parse, client } = clientWith(async () => fakeResponse());
    await client.analyzeImage({ bytes: TEST_PNG, mimeType: "image/png" });

    const content = parse.mock.calls[0][0].input[0].content;
    const image = content.find((c: any) => c.type === "input_image");
    expect(image.detail).toBe("high");
    expect(image.image_url).toBe(`data:image/png;base64,${Buffer.from(TEST_PNG).toString("base64")}`);
    expect(content.find((c: any) => c.type === "input_text")).toBeDefined();
  });

  it("uses the configured model", async () => {
    const { parse, client } = clientWith(async () => fakeResponse(), "gpt-6-luna-custom");
    await client.analyzeImage(jpeg);
    expect(parse.mock.calls[0][0].model).toBe("gpt-6-luna-custom");
  });

  it("returns validated output, the reported model and token usage", async () => {
    const { client } = clientWith(async () => fakeResponse({ model: "gpt-6-luna-2026-10-01" }));
    const result = await client.analyzeImage(jpeg);

    expect(result.analysis).toEqual(SYNTHETIC_RAW_CHAIR);
    expect(result.responseModel).toBe("gpt-6-luna-2026-10-01");
    expect(result.responseId).toBe("resp_synthetic_1");
    expect(result.usage).toEqual({ inputTokens: 1200, outputTokens: 300, totalTokens: 1500, reasoningTokens: 80 });
  });

  it("creates SDK clients with automatic retries disabled and without network access", () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    const sdk = createOpenAIClient("sk-test-not-a-real-key", 5_000);

    expect(sdk.maxRetries).toBe(0);
    expect(sdk.timeout).toBe(5_000);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe("OpenAIVisionClient response handling", () => {
  it("reports a refusal", async () => {
    const { client } = clientWith(async () =>
      fakeResponse({
        output: [{ type: "message", content: [{ type: "refusal", refusal: "I can't help with that." }] }],
        output_parsed: null,
      }),
    );
    const error = await expectCategory(client, "refusal");
    expect(error.message).not.toContain("I can't help");
  });

  it("reports an incomplete response with its reason", async () => {
    const { client } = clientWith(async () =>
      fakeResponse({ status: "incomplete", incomplete_details: { reason: "max_output_tokens" }, output_parsed: null }),
    );
    const error = await expectCategory(client, "incomplete");
    expect(error.message).toContain("max_output_tokens");
  });

  it("keeps response id and usage on failures that happen after a response", async () => {
    const { client } = clientWith(async () =>
      fakeResponse({ status: "incomplete", incomplete_details: { reason: "max_output_tokens" }, output_parsed: null }),
    );
    const error = await expectCategory(client, "incomplete");
    expect(error.response).toEqual({
      responseId: "resp_synthetic_1",
      responseModel: "gpt-6-luna",
      usage: { inputTokens: 1200, outputTokens: 300, totalTokens: 1500, reasoningTokens: 80 },
    });
  });

  it("reports missing parsed output", async () => {
    const { client } = clientWith(async () => fakeResponse({ output: [], output_parsed: null }));
    await expectCategory(client, "missing_output");
  });

  it("re-validates parsed output instead of trusting the SDK", async () => {
    const { client } = clientWith(async () =>
      fakeResponse({ output_parsed: { ...SYNTHETIC_RAW_CHAIR, outcome: "chair_probably" } }),
    );
    const error = await expectCategory(client, "malformed_output");
    expect(error.message).toContain("outcome");
  });

  it("classifies SDK parse failures as malformed output", async () => {
    const zodFailure = z.object({ a: z.string() }).safeParse({});
    const { client } = clientWith(async () => {
      throw zodFailure.error;
    });
    await expectCategory(client, "malformed_output");

    const { client: jsonClient } = clientWith(async () => {
      throw new SyntaxError("Unexpected end of JSON input");
    });
    await expectCategory(jsonClient, "malformed_output");
  });

  it.each<[string, () => Error, VisionModelErrorCategory]>([
    ["401", () => new OpenAI.AuthenticationError(401, {}, "Incorrect API key", headers), "authentication"],
    ["403", () => new OpenAI.PermissionDeniedError(403, {}, "No access", headers), "permission"],
    ["404", () => new OpenAI.NotFoundError(404, {}, "Model not found", headers), "model_not_found"],
    ["429", () => new OpenAI.RateLimitError(429, {}, "Rate limit", headers), "rate_limit"],
    ["400", () => new OpenAI.BadRequestError(400, {}, "Image too large", headers), "bad_request"],
    ["500", () => new OpenAI.InternalServerError(500, {}, "Oops", headers), "server_error"],
    ["timeout", () => new OpenAI.APIConnectionTimeoutError(), "timeout"],
    ["network", () => new OpenAI.APIConnectionError({ message: "ECONNRESET" }), "network"],
    ["anything else", () => new Error("boom"), "unexpected"],
  ])("classifies a %s error without retrying", async (_name, makeError, category) => {
    const { parse, client } = clientWith(async () => {
      throw makeError();
    });
    const error = await expectCategory(client, category);
    expect(parse).toHaveBeenCalledTimes(1);
    expect(error.cause).toBeDefined();
  });

  it("keeps the request id and status for API errors", async () => {
    const { client } = clientWith(async () => {
      throw new OpenAI.RateLimitError(429, {}, "Rate limit", headers);
    });
    const error = await expectCategory(client, "rate_limit");
    expect(error.status).toBe(429);
    expect(error.requestId).toBe("req_synthetic");
  });

  it("never includes the image data or API key in error messages", async () => {
    const { client } = clientWith(async () => {
      throw new OpenAI.AuthenticationError(401, {}, "Incorrect API key provided", headers);
    });
    const error = await expectCategory(client, "authentication");
    expect(error.message).not.toContain(Buffer.from(TEST_JPEG).toString("base64"));
    expect(error.message).not.toMatch(/sk-/);
  });
});
