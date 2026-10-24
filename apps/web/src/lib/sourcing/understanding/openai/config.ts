import { DEFAULT_IMAGE_UNDERSTANDING_MODEL } from "./vision-client";

export interface ImageUnderstandingConfig {
  /** Undefined when OPENAI_API_KEY is not set. Never log this value. */
  apiKey?: string;
  model: string;
}

/** Reads server-side configuration. Secrets must never use NEXT_PUBLIC_. */
export function readImageUnderstandingConfig(
  env: Record<string, string | undefined>,
): ImageUnderstandingConfig {
  const apiKey = env.OPENAI_API_KEY?.trim() || undefined;
  const model = env.OPENAI_IMAGE_UNDERSTANDING_MODEL?.trim() || DEFAULT_IMAGE_UNDERSTANDING_MODEL;
  return { apiKey, model };
}
