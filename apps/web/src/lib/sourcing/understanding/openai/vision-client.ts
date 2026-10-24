import OpenAI from "openai";
import { zodTextFormat } from "openai/helpers/zod";
import { z } from "zod";
import { toDataUrl, type ImageContent } from "../../image-input/image-content";
import { summarizeIssues } from "../../validation/issues";
import { VisionModelError, type ModelResponseMeta } from "./errors";
import {
  FURNITURE_UNDERSTANDING_INSTRUCTIONS,
  FURNITURE_UNDERSTANDING_USER_PROMPT,
} from "./instructions";
import {
  RAW_VISION_FORMAT_NAME,
  rawVisionAnalysisSchema,
  type RawVisionAnalysis,
} from "./raw-response";

export const DEFAULT_IMAGE_UNDERSTANDING_MODEL = "gpt-6-luna";

export interface VisionRequestSettings {
  model: string;
  imageDetail: "high";
  reasoningEffort: "low";
  /** Includes reasoning tokens. */
  maxOutputTokens: number;
  timeoutMs: number;
}

export const DEFAULT_VISION_REQUEST_SETTINGS: Omit<VisionRequestSettings, "model"> = {
  imageDetail: "high",
  reasoningEffort: "low",
  maxOutputTokens: 4096,
  timeoutMs: 60_000,
};

export interface VisionTokenUsage {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  reasoningTokens?: number;
}

export interface VisionAnalysisResult {
  /** Structurally valid but still untrusted model output. */
  analysis: RawVisionAnalysis;
  /** Model reported by the API response (may be a dated snapshot). */
  responseModel: string;
  responseId: string;
  usage?: VisionTokenUsage;
}

/** Model-facing boundary. Replaced by a test double in tests. */
export interface VisionModelClient {
  readonly settings: VisionRequestSettings;
  analyzeImage(image: ImageContent): Promise<VisionAnalysisResult>;
}

/** The single SDK method this client uses, so tests can inject a fake. */
export type ResponsesParseFn = OpenAI["responses"]["parse"];

/**
 * Creates the SDK client with automatic retries disabled, so one call can
 * never become several paid requests. Server-side only.
 */
export function createOpenAIClient(apiKey: string, timeoutMs: number): OpenAI {
  if (typeof window !== "undefined") {
    throw new Error("The OpenAI client must not be created in browser code");
  }
  return new OpenAI({ apiKey, maxRetries: 0, timeout: timeoutMs });
}

const rawFormat = zodTextFormat(rawVisionAnalysisSchema, RAW_VISION_FORMAT_NAME);

/**
 * GPT-6 Luna via the Responses API with Structured Outputs. One request per
 * call: no retries, no tools, `store: false`. The image is sent inline as a
 * base64 data URL and is never logged.
 */
export class OpenAIVisionClient implements VisionModelClient {
  readonly settings: VisionRequestSettings;
  private readonly parse: ResponsesParseFn;

  constructor(options: {
    parse: ResponsesParseFn;
    model?: string;
    settings?: Partial<Omit<VisionRequestSettings, "model">>;
  }) {
    this.parse = options.parse;
    this.settings = {
      ...DEFAULT_VISION_REQUEST_SETTINGS,
      ...options.settings,
      model: options.model ?? DEFAULT_IMAGE_UNDERSTANDING_MODEL,
    };
  }

  static fromApiKey(apiKey: string, model?: string): OpenAIVisionClient {
    const client = createOpenAIClient(apiKey, DEFAULT_VISION_REQUEST_SETTINGS.timeoutMs);
    return new OpenAIVisionClient({
      parse: client.responses.parse.bind(client.responses) as ResponsesParseFn,
      model,
    });
  }

  async analyzeImage(image: ImageContent): Promise<VisionAnalysisResult> {
    const { model, imageDetail, reasoningEffort, maxOutputTokens, timeoutMs } = this.settings;

    let response: Awaited<ReturnType<typeof this.requestParse>>;
    try {
      response = await this.requestParse({
        model,
        instructions: FURNITURE_UNDERSTANDING_INSTRUCTIONS,
        input: [
          {
            role: "user",
            content: [
              { type: "input_text", text: FURNITURE_UNDERSTANDING_USER_PROMPT },
              { type: "input_image", image_url: toDataUrl(image), detail: imageDetail },
            ],
          },
        ],
        text: { format: rawFormat },
        reasoning: { effort: reasoningEffort },
        max_output_tokens: maxOutputTokens,
        tools: [],
        store: false,
      }, timeoutMs);
    } catch (error) {
      throw classifyRequestError(error);
    }

    if (response.status === "incomplete") {
      const reason = response.incomplete_details?.reason ?? "unknown";
      throw new VisionModelError("incomplete", `Model response was incomplete (${reason})`, {
        requestId: response._request_id ?? undefined,
        response: responseMeta(response),
      });
    }
    if (response.status && response.status !== "completed") {
      throw new VisionModelError("unexpected", `Model response status was "${response.status}"`, {
        requestId: response._request_id ?? undefined,
        response: responseMeta(response),
      });
    }

    const refusal = findRefusal(response.output);
    if (refusal !== undefined) {
      throw new VisionModelError("refusal", "Model refused to analyse the image", {
        requestId: response._request_id ?? undefined,
        response: responseMeta(response),
      });
    }

    if (response.output_parsed == null) {
      throw new VisionModelError("missing_output", "Model returned no structured output", {
        requestId: response._request_id ?? undefined,
        response: responseMeta(response),
      });
    }

    // Re-check independently of the SDK's own parse.
    const checked = rawVisionAnalysisSchema.safeParse(response.output_parsed);
    if (!checked.success) {
      throw new VisionModelError(
        "malformed_output",
        `Model output failed validation: ${summarizeIssues(checked.error)}`,
        { cause: checked.error, requestId: response._request_id ?? undefined, response: responseMeta(response) },
      );
    }

    return {
      analysis: checked.data,
      ...responseMeta(response),
    };
  }

  private requestParse(body: Parameters<ResponsesParseFn>[0] & { text: { format: typeof rawFormat } }, timeoutMs: number) {
    return this.parse(body, { maxRetries: 0, timeout: timeoutMs }) as unknown as Promise<
      OpenAI.Responses.ParsedResponse<RawVisionAnalysis> & { _request_id?: string | null }
    >;
  }
}

function responseMeta(response: OpenAI.Responses.Response): ModelResponseMeta {
  return {
    responseId: response.id,
    responseModel: response.model,
    usage: response.usage
      ? {
          inputTokens: response.usage.input_tokens,
          outputTokens: response.usage.output_tokens,
          totalTokens: response.usage.total_tokens,
          reasoningTokens: response.usage.output_tokens_details?.reasoning_tokens,
        }
      : undefined,
  };
}

function findRefusal(output: readonly OpenAI.Responses.ResponseOutputItem[]): string | undefined {
  for (const item of output) {
    if (item.type !== "message") continue;
    for (const content of item.content) {
      if (content.type === "refusal") return content.refusal;
    }
  }
  return undefined;
}

/** Maps SDK and parse errors to categories, keeping messages payload-free. */
export function classifyRequestError(error: unknown): VisionModelError {
  if (error instanceof VisionModelError) return error;

  if (error instanceof OpenAI.APIError) {
    const details = { status: error.status, requestId: error.requestID ?? undefined, cause: error };
    if (error instanceof OpenAI.APIConnectionTimeoutError) {
      return new VisionModelError("timeout", "Request to OpenAI timed out", details);
    }
    if (error instanceof OpenAI.APIConnectionError) {
      return new VisionModelError("network", "Could not connect to OpenAI", details);
    }
    if (error instanceof OpenAI.AuthenticationError) {
      return new VisionModelError("authentication", "OpenAI rejected the API key (401)", details);
    }
    if (error instanceof OpenAI.PermissionDeniedError) {
      return new VisionModelError("permission", "API key lacks access to this model or feature (403)", details);
    }
    if (error instanceof OpenAI.NotFoundError) {
      return new VisionModelError("model_not_found", "Model not found or not available to this account (404)", details);
    }
    if (error instanceof OpenAI.RateLimitError) {
      return new VisionModelError("rate_limit", "Rate limit or quota exceeded (429)", details);
    }
    if (error instanceof OpenAI.BadRequestError || error instanceof OpenAI.UnprocessableEntityError) {
      // The API's own message is safe to show and explains e.g. image limits.
      return new VisionModelError("bad_request", `OpenAI rejected the request (${error.status}): ${error.message}`, details);
    }
    if (typeof error.status === "number" && error.status >= 500) {
      return new VisionModelError("server_error", `OpenAI server error (${error.status})`, details);
    }
    return new VisionModelError("unexpected", `OpenAI request failed (${error.status ?? "no status"})`, details);
  }

  // The SDK parses structured output with the Zod schema; failures surface here.
  if (error instanceof z.ZodError) {
    return new VisionModelError("malformed_output", `Model output failed validation: ${summarizeIssues(error)}`, { cause: error });
  }
  if (error instanceof SyntaxError) {
    return new VisionModelError("malformed_output", "Model output was not valid JSON", { cause: error });
  }
  return new VisionModelError("unexpected", "Unexpected error during the OpenAI request", { cause: error });
}
