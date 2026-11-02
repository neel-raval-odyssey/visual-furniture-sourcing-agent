import { readFile } from "node:fs/promises";
import { z } from "zod";
import { APIFY_PROVIDER_ID, SCRAPEWISE_ACTOR } from "./providers/apify/actor-input";

/**
 * Source eligibility for live marketplace discovery. Separates what the code
 * can do (a provider is implemented), what is configured (credentials), and
 * what a person has established and recorded (access basis, data-use review,
 * image-transfer approval, live switch). Project policy (AGENTS.md: an
 * official API or approved partner, no scraping) is applied to the provider's
 * acquisition method and fails closed: no record or flag can enable a scraper.
 * Nothing here contacts a network.
 */

export type DiscoveryMode = "image" | "keyword" | "hybrid";

export interface ProviderDefinition {
  id: string;
  label: string;
  /** "official_api": the marketplace's own API. "licensed_partner": a documented data licence. "scraper": retrieves pages without the marketplace's permission. */
  acquisition: "official_api" | "licensed_partner" | "scraper";
  implemented: boolean;
  modes: readonly DiscoveryMode[];
  credentialEnv: string;
  docs: string;
}

/** Providers this code base can talk to. Adding one is a code change, reviewed like any other. */
export const PROVIDERS: Record<string, ProviderDefinition> = {
  [APIFY_PROVIDER_ID]: {
    id: APIFY_PROVIDER_ID,
    label: `Apify Actor ${SCRAPEWISE_ACTOR} (third-party scraper, not an official Alibaba.com API)`,
    acquisition: "scraper",
    implemented: true,
    modes: ["image", "keyword", "hybrid"],
    credentialEnv: "APIFY_TOKEN",
    docs: "docs/automated-marketplace-discovery.md",
  },
};

/** Acquisition methods the project rules allow (AGENTS.md). Changing this is a human policy decision. */
export const POLICY_ALLOWED_ACQUISITION: readonly ProviderDefinition["acquisition"][] = ["official_api", "licensed_partner"];

/**
 * Private, human-maintained record of established access
 * (evals/local/marketplace-access.json, git-ignored). It documents a review;
 * it is not itself a legal right, and it cannot override project policy.
 */
export const marketplaceAccessRecordSchema = z.strictObject({
  schemaVersion: z.literal(1),
  providers: z.record(
    z.string(),
    z.strictObject({
      accessBasis: z.enum(["official_api_agreement", "licensed_partner_agreement"]),
      /** Where the written agreement or approval is kept (a reference, not the document). */
      agreementReference: z.string().min(3),
      reviewedBy: z.string().min(1),
      reviewedAt: z.iso.date(),
      permittedModes: z.array(z.enum(["image", "keyword", "hybrid"])).min(1),
      imageTransferApproved: z.boolean(),
      liveEnabled: z.boolean(),
      maxResultsPerRun: z.int().min(1).max(50),
      maxCostUsdPerRun: z.number().positive().max(10),
      notes: z.string().optional(),
    }),
  ),
});
export type MarketplaceAccessRecord = z.output<typeof marketplaceAccessRecordSchema>;

export type AccessRecordLoad = { state: "missing" } | { state: "invalid"; problem: string } | { state: "ok"; record: MarketplaceAccessRecord };

export async function loadAccessRecord(path: string): Promise<AccessRecordLoad> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch {
    return { state: "missing" };
  }
  try {
    const parsed = marketplaceAccessRecordSchema.safeParse(JSON.parse(text));
    return parsed.success ? { state: "ok", record: parsed.data } : { state: "invalid", problem: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ") };
  } catch {
    return { state: "invalid", problem: "not valid JSON" };
  }
}

export type CheckKey = "implemented" | "policy" | "credentials" | "access_record" | "image_transfer" | "live_enabled";

export interface EligibilityCheck {
  key: CheckKey;
  ok: boolean;
  detail: string;
}

export interface SourceEligibility {
  providerId: string;
  mode: DiscoveryMode;
  eligible: boolean;
  checks: EligibilityCheck[];
  /** Plain reason for the first failing check, for user-facing text. */
  blocker: string | null;
  /** Caps from the access record when eligible. */
  limits: { maxResults: number; maxCostUsd: number } | null;
}

export function checkSourceEligibility(input: { providerId: string; mode: DiscoveryMode; env: Record<string, string | undefined>; access: AccessRecordLoad }): SourceEligibility {
  const provider = PROVIDERS[input.providerId];
  const checks: EligibilityCheck[] = [];
  const add = (key: CheckKey, ok: boolean, detail: string) => checks.push({ key, ok, detail });
  const entry = input.access.state === "ok" ? input.access.record.providers[input.providerId] : undefined;
  const needsImage = input.mode !== "keyword";

  add("implemented", Boolean(provider?.implemented && provider.modes.includes(input.mode)), provider ? `${provider.label}; modes ${provider.modes.join(", ")}` : "No such provider is implemented");
  add(
    "policy",
    Boolean(provider && POLICY_ALLOWED_ACQUISITION.includes(provider.acquisition)),
    provider?.acquisition === "scraper"
      ? "Project rules allow only an official API or an approved partner; this provider scrapes the marketplace, so live use is blocked"
      : provider
        ? `Acquisition method: ${provider.acquisition}`
        : "Unknown provider",
  );
  add("credentials", Boolean(provider && input.env[provider.credentialEnv]?.trim()), provider ? `${provider.credentialEnv} ${input.env[provider.credentialEnv]?.trim() ? "is set" : "is not set"}` : "—");
  add(
    "access_record",
    Boolean(entry?.permittedModes.includes(input.mode)),
    input.access.state === "missing"
      ? "No access record (evals/local/marketplace-access.json): permission and data-use review have not been recorded"
      : input.access.state === "invalid"
        ? `The access record is invalid: ${input.access.problem}`
        : entry
          ? `${entry.accessBasis} (${entry.agreementReference}), reviewed by ${entry.reviewedBy} on ${entry.reviewedAt}; permitted modes ${entry.permittedModes.join(", ")}`
          : "The access record has no entry for this provider",
  );
  add("image_transfer", !needsImage || Boolean(entry?.imageTransferApproved), needsImage ? (entry?.imageTransferApproved ? "Sending reference photos to this provider is approved" : "Sending reference photos to this provider has not been approved") : "Not needed for keyword search");
  add("live_enabled", Boolean(entry?.liveEnabled), entry?.liveEnabled ? "Live use is enabled in the access record" : "Live use is not enabled");

  const failed = checks.find((c) => !c.ok);
  return {
    providerId: input.providerId,
    mode: input.mode,
    eligible: !failed,
    checks,
    blocker: failed?.detail ?? null,
    limits: !failed && entry ? { maxResults: entry.maxResultsPerRun, maxCostUsd: entry.maxCostUsdPerRun } : null,
  };
}

/** Eligibility of every implemented provider for one mode, for display. */
export function discoveryReadiness(mode: DiscoveryMode, env: Record<string, string | undefined>, access: AccessRecordLoad): SourceEligibility[] {
  return Object.keys(PROVIDERS).map((providerId) => checkSourceEligibility({ providerId, mode, env, access }));
}
