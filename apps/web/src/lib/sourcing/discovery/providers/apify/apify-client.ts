import { z } from "zod";

/**
 * Minimal client for the documented Apify REST API v2
 * (https://docs.apify.com/api/v2). The token is sent only in the
 * `Authorization: Bearer` header, never in URLs, and never appears in errors.
 *
 * Nothing here retries a request that can start paid work (starting a run).
 * Read-only status and dataset requests may be repeated by the caller.
 */

export const APIFY_BASE_URL = "https://api.apify.com/v2";

export type ApifyErrorCategory =
  | "authentication"
  | "payment_required"
  | "permission"
  | "not_found"
  | "rate_limit"
  | "bad_request"
  | "server_error"
  | "timeout"
  | "network"
  | "malformed_response";

export class ApifyError extends Error {
  constructor(
    readonly category: ApifyErrorCategory,
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = "ApifyError";
  }
}

export const RUN_STATUSES = ["READY", "RUNNING", "SUCCEEDED", "FAILED", "TIMING-OUT", "TIMED-OUT", "ABORTING", "ABORTED"] as const;
export type ApifyRunStatus = (typeof RUN_STATUSES)[number];
export const TERMINAL_STATUSES: ReadonlySet<ApifyRunStatus> = new Set(["SUCCEEDED", "FAILED", "TIMED-OUT", "ABORTED"]);

const runSchema = z.looseObject({
  id: z.string().min(1),
  actId: z.string().optional(),
  status: z.enum(RUN_STATUSES),
  statusMessage: z.string().nullable().optional(),
  startedAt: z.string().nullable().optional(),
  finishedAt: z.string().nullable().optional(),
  defaultDatasetId: z.string().min(1),
  chargedEventCounts: z.record(z.string(), z.number()).nullable().optional(),
  usageTotalUsd: z.number().nullable().optional(),
  options: z.looseObject({ maxTotalChargeUsd: z.number().nullable().optional(), timeoutSecs: z.number().optional() }).optional(),
});

export interface ApifyRun {
  id: string;
  status: ApifyRunStatus;
  statusMessage: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  datasetId: string;
  chargedEventCounts: Record<string, number> | null;
  /** Total cost reported by Apify (event charges for pay-per-event Actors); null when not reported. */
  usageTotalUsd: number | null;
  maxTotalChargeUsd: number | null;
}

export interface RunOptions {
  /** Run timeout in seconds (Apify `timeout`). */
  timeoutSecs: number;
  /** Hard cap on the run's total charge (Apify `maxTotalChargeUsd`). */
  maxTotalChargeUsd: number;
  /** Cap on charged dataset items (Apify `maxItems`). */
  maxItems: number;
  /** Memory in MB (power of 2). Omitted to use the Actor's default. */
  memoryMbytes?: number;
}

export type FetchLike = (url: string, init: { method: string; headers: Record<string, string>; body?: BodyInit; signal: AbortSignal }) => Promise<Response>;

export interface ApifyClientOptions {
  token: string;
  fetch?: FetchLike;
  baseUrl?: string;
  /** Per HTTP request. */
  requestTimeoutMs?: number;
}

function toRun(raw: unknown): ApifyRun {
  const parsed = runSchema.safeParse((raw as { data?: unknown } | null)?.data);
  if (!parsed.success) throw new ApifyError("malformed_response", "Apify returned an unrecognised run object");
  const r = parsed.data;
  return {
    id: r.id,
    status: r.status,
    statusMessage: r.statusMessage ?? null,
    startedAt: r.startedAt ?? null,
    finishedAt: r.finishedAt ?? null,
    datasetId: r.defaultDatasetId,
    chargedEventCounts: r.chargedEventCounts ?? null,
    usageTotalUsd: r.usageTotalUsd ?? null,
    maxTotalChargeUsd: r.options?.maxTotalChargeUsd ?? null,
  };
}

const ID = /^[A-Za-z0-9]{1,40}$/;
const actorPath = (actor: string) => {
  const [user, name] = actor.split("/");
  if (!user || !name || !/^[a-z0-9-]+$/i.test(user) || !/^[a-z0-9-]+$/i.test(name)) throw new Error(`Invalid Actor id "${actor}"`);
  return `${user}~${name}`;
};
const checkId = (id: string, what: string) => {
  if (!ID.test(id)) throw new ApifyError("bad_request", `Invalid ${what} id`);
  return id;
};

export class ApifyClient {
  private readonly fetchFn: FetchLike;
  private readonly baseUrl: string;
  private readonly timeoutMs: number;

  constructor(private readonly options: ApifyClientOptions) {
    if (!options.token) throw new ApifyError("authentication", "No Apify token configured");
    this.fetchFn = options.fetch ?? ((url, init) => fetch(url, init));
    this.baseUrl = options.baseUrl ?? APIFY_BASE_URL;
    this.timeoutMs = options.requestTimeoutMs ?? 30_000;
  }

  private async request(method: string, path: string, query: Record<string, string> = {}, body?: { json?: unknown; bytes?: Uint8Array; contentType?: string }): Promise<Response> {
    const url = new URL(`${this.baseUrl}${path}`);
    for (const [k, v] of Object.entries(query)) url.searchParams.set(k, v);
    const headers: Record<string, string> = { Authorization: `Bearer ${this.options.token}`, Accept: "application/json" };
    let payload: BodyInit | undefined;
    if (body?.json !== undefined) {
      headers["Content-Type"] = "application/json";
      payload = JSON.stringify(body.json);
    } else if (body?.bytes) {
      headers["Content-Type"] = body.contentType ?? "application/octet-stream";
      payload = new Blob([body.bytes as Uint8Array<ArrayBuffer>]);
    }
    let response: Response;
    try {
      response = await this.fetchFn(url.toString(), { method, headers, body: payload, signal: AbortSignal.timeout(this.timeoutMs) });
    } catch (error) {
      const name = (error as Error)?.name;
      if (name === "TimeoutError" || name === "AbortError") throw new ApifyError("timeout", `Apify request timed out after ${this.timeoutMs} ms`);
      throw new ApifyError("network", "Could not connect to Apify");
    }
    if (response.ok) return response;
    const status = response.status;
    let detail = "";
    try {
      const err = (await response.json()) as { error?: { type?: string; message?: string } };
      detail = [err.error?.type, err.error?.message].filter(Boolean).join(": ").slice(0, 300);
    } catch {
      // No JSON error body.
    }
    const suffix = detail ? ` (${detail})` : "";
    if (status === 401) throw new ApifyError("authentication", `Apify rejected the token (401)${suffix}`, status);
    if (status === 402) throw new ApifyError("payment_required", `Apify account cannot pay for this run (402)${suffix}`, status);
    if (status === 403) throw new ApifyError("permission", `Apify denied access (403)${suffix}`, status);
    if (status === 404) throw new ApifyError("not_found", `Apify resource not found (404)${suffix}`, status);
    if (status === 429) throw new ApifyError("rate_limit", `Apify rate limit exceeded (429)${suffix}`, status);
    if (status >= 500) throw new ApifyError("server_error", `Apify server error (${status})`, status);
    throw new ApifyError("bad_request", `Apify rejected the request (${status})${suffix}`, status);
  }

  private async json(response: Response): Promise<unknown> {
    try {
      return await response.json();
    } catch {
      throw new ApifyError("malformed_response", "Apify returned invalid JSON");
    }
  }

  /** Starts one Actor run. Never retried: a lost response may still mean a started, chargeable run. */
  async startRun(actor: string, input: unknown, opts: RunOptions): Promise<ApifyRun> {
    const query: Record<string, string> = {
      timeout: String(opts.timeoutSecs),
      maxTotalChargeUsd: String(opts.maxTotalChargeUsd),
      maxItems: String(opts.maxItems),
    };
    if (opts.memoryMbytes) query.memory = String(opts.memoryMbytes);
    return toRun(await this.json(await this.request("POST", `/acts/${actorPath(actor)}/runs`, query, { json: input })));
  }

  /** Current run state; waits server-side up to `waitSecs` (max 60) for a terminal status. */
  async getRun(runId: string, waitSecs = 0): Promise<ApifyRun> {
    const query = waitSecs > 0 ? { waitForFinish: String(Math.min(60, Math.floor(waitSecs))) } : undefined;
    return toRun(await this.json(await this.request("GET", `/actor-runs/${checkId(runId, "run")}`, query)));
  }

  async abortRun(runId: string): Promise<ApifyRun> {
    return toRun(await this.json(await this.request("POST", `/actor-runs/${checkId(runId, "run")}/abort`)));
  }

  /** Recent runs of an Actor, newest first (for reconciling an uncertain start). */
  async listRecentRuns(actor: string, limit = 10): Promise<ApifyRun[]> {
    const raw = (await this.json(await this.request("GET", `/acts/${actorPath(actor)}/runs`, { desc: "1", limit: String(limit) }))) as {
      data?: { items?: unknown[] };
    };
    const items = raw?.data?.items;
    if (!Array.isArray(items)) throw new ApifyError("malformed_response", "Apify returned an unrecognised run list");
    return items.flatMap((item) => {
      const parsed = runSchema.safeParse(item);
      return parsed.success ? [toRun({ data: item })] : [];
    });
  }

  /** Dataset items as a JSON array (`clean` removes hidden fields). Read-only. */
  async getDatasetItems(datasetId: string, limit: number): Promise<unknown[]> {
    const raw = await this.json(
      await this.request("GET", `/datasets/${checkId(datasetId, "dataset")}/items`, { format: "json", clean: "true", limit: String(limit) }),
    );
    if (!Array.isArray(raw)) throw new ApifyError("malformed_response", "Apify dataset items were not a JSON array");
    return raw;
  }

  /** Creates an unnamed key-value store for a temporary upload. */
  async createKeyValueStore(): Promise<{ id: string }> {
    const raw = (await this.json(await this.request("POST", "/key-value-stores"))) as { data?: { id?: unknown } };
    const id = raw?.data?.id;
    if (typeof id !== "string" || !ID.test(id)) throw new ApifyError("malformed_response", "Apify returned no key-value store id");
    return { id };
  }

  async putRecord(storeId: string, key: string, bytes: Uint8Array, contentType: string): Promise<void> {
    if (!/^[A-Za-z0-9._-]{1,100}$/.test(key)) throw new ApifyError("bad_request", "Invalid record key");
    await this.request("PUT", `/key-value-stores/${checkId(storeId, "store")}/records/${key}`, {}, { bytes, contentType });
  }

  async deleteKeyValueStore(storeId: string): Promise<void> {
    await this.request("DELETE", `/key-value-stores/${checkId(storeId, "store")}`);
  }

  recordUrl(storeId: string, key: string): string {
    return `${this.baseUrl}/key-value-stores/${checkId(storeId, "store")}/records/${key}`;
  }
}
