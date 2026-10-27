import type OpenAI from "openai";
import { zodTextFormat } from "openai/helpers/zod";
import { toDataUrl, type ImageContent } from "../../image-input/image-content";
import { VisionModelError, type ModelResponseMeta } from "../../understanding/openai/errors";
import {
  classifyRequestError,
  createOpenAIClient,
  type ResponsesParseFn,
  type VisionTokenUsage,
} from "../../understanding/openai/vision-client";
import { summarizeIssues } from "../../validation/issues";
import {
  CANDIDATE_LABEL,
  pairClosingText,
  PAIR_INTRO_TEXT,
  REFERENCE_LABEL,
  VISUAL_VERIFICATION_INSTRUCTIONS,
} from "./instructions";
import { RAW_VERIFICATION_FORMAT_NAME, rawVisualVerificationSchema, type RawVisualVerification } from "./raw-response";

export const DEFAULT_VISUAL_VERIFICATION_MODEL = "gpt-6.1-sol";

export interface VerificationRequestSettings {
  model: string;
  imageDetail: "high";
  reasoningEffort: "medium";
  /** Includes reasoning tokens. */
  maxOutputTokens: number;
  timeoutMs: number;
}

export const DEFAULT_VERIFICATION_REQUEST_SETTINGS: Omit<VerificationRequestSettings, "model"> = {
  imageDetail: "high",
  reasoningEffort: "medium",
  maxOutputTokens: 6000,
  timeoutMs: 180_000,
};

export interface PairComparisonInput {
  reference: ImageContent;
  candidate: ImageContent;
  /** Formatted reference observations (fingerprint), the only text context sent. */
  referenceObservations: string;
}

export interface PairComparisonResult {
  /** Structurally valid but still untrusted model output. */
  verification: RawVisualVerification;
  responseId: string;
  /** Model reported by the API response (may be a dated snapshot). */
  responseModel: string;
  usage?: VisionTokenUsage;
}

/** Model-facing boundary. Replaced by a test double in tests. */
export interface VisualVerificationModelClient {
  readonly settings: VerificationRequestSettings;
  comparePair(input: PairComparisonInput): Promise<PairComparisonResult>;
}

const rawFormat = zodTextFormat(rawVisualVerificationSchema, RAW_VERIFICATION_FORMAT_NAME);

/** The exact Responses API request body for one pair. Exported so tests can inspect what is sent. */
export function buildPairRequestBody(settings: VerificationRequestSettings, input: PairComparisonInput) {
  return {
    model: settings.model,
    instructions: VISUAL_VERIFICATION_INSTRUCTIONS,
    input: [
      {
        role: "user" as const,
        content: [
          { type: "input_text" as const, text: PAIR_INTRO_TEXT },
          { type: "input_text" as const, text: REFERENCE_LABEL },
          { type: "input_image" as const, image_url: toDataUrl(input.reference), detail: settings.imageDetail },
          { type: "input_text" as const, text: CANDIDATE_LABEL },
          { type: "input_image" as const, image_url: toDataUrl(input.candidate), detail: settings.imageDetail },
          { type: "input_text" as const, text: pairClosingText(input.referenceObservations) },
        ],
      },
    ],
    text: { format: rawFormat },
    reasoning: { effort: settings.reasoningEffort },
    max_output_tokens: settings.maxOutputTokens,
    tools: [],
    store: false,
  };
}

/**
 * GPT-6.1 Sol via the Responses API with Structured Outputs. One request per
 * call: no retries, no tools, no fallback model, `store: false`. Images are
 * sent inline as base64 data URLs and never logged.
 */
export class OpenAIVisualVerificationClient implements VisualVerificationModelClient {
  readonly settings: VerificationRequestSettings;
  private readonly parse: ResponsesParseFn;

  constructor(options: { parse: ResponsesParseFn; model?: string; settings?: Partial<Omit<VerificationRequestSettings, "model">> }) {
    this.parse = options.parse;
    this.settings = {
      ...DEFAULT_VERIFICATION_REQUEST_SETTINGS,
      ...options.settings,
      model: options.model ?? DEFAULT_VISUAL_VERIFICATION_MODEL,
    };
  }

  static fromApiKey(
    apiKey: string,
    options: { model?: string; settings?: Partial<Omit<VerificationRequestSettings, "model">> } = {},
  ): OpenAIVisualVerificationClient {
    const timeoutMs = options.settings?.timeoutMs ?? DEFAULT_VERIFICATION_REQUEST_SETTINGS.timeoutMs;
    const client = createOpenAIClient(apiKey, timeoutMs);
    return new OpenAIVisualVerificationClient({
      parse: client.responses.parse.bind(client.responses) as ResponsesParseFn,
      ...options,
    });
  }

  async comparePair(input: PairComparisonInput): Promise<PairComparisonResult> {
    let response: OpenAI.Responses.ParsedResponse<RawVisualVerification> & { _request_id?: string | null };
    try {
      response = (await this.parse(buildPairRequestBody(this.settings, input) as Parameters<ResponsesParseFn>[0], {
        maxRetries: 0,
        timeout: this.settings.timeoutMs,
      })) as unknown as typeof response;
    } catch (error) {
      throw classifyRequestError(error);
    }
    const details = () => ({ requestId: response._request_id ?? undefined, response: responseMeta(response) });

    if (response.status === "incomplete") {
      throw new VisionModelError("incomplete", `Model response was incomplete (${response.incomplete_details?.reason ?? "unknown"})`, details());
    }
    if (response.status && response.status !== "completed") {
      throw new VisionModelError("unexpected", `Model response status was "${response.status}"`, details());
    }
    if (findRefusal(response.output)) {
      throw new VisionModelError("refusal", "Model refused to compare the images", details());
    }
    if (response.output_parsed == null) {
      throw new VisionModelError("missing_output", "Model returned no structured output", details());
    }
    const checked = rawVisualVerificationSchema.safeParse(response.output_parsed);
    if (!checked.success) {
      throw new VisionModelError("malformed_output", `Model output failed validation: ${summarizeIssues(checked.error)}`, {
        cause: checked.error,
        ...details(),
      });
    }
    return { verification: checked.data, ...responseMeta(response) };
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

function findRefusal(output: readonly OpenAI.Responses.ResponseOutputItem[]): boolean {
  return output.some((item) => item.type === "message" && item.content.some((c) => c.type === "refusal"));
}
