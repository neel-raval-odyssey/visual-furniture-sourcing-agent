import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

/**
 * The sourcing web experience reads private local records (photographs,
 * listings, model outputs) and has no authentication. It is therefore a
 * local-development tool:
 *
 * - enabled only when VFSA_LOCAL_SOURCING_UI=1 and NODE_ENV is not "production";
 * - API routes additionally accept only loopback Host headers (localhost,
 *   127.0.0.1, [::1]), which also blocks DNS-rebinding requests from web pages.
 *
 * Run the dev server bound to loopback (`pnpm dev:local`). A production build
 * serves none of this data until an access-control layer exists.
 */

export const LOCAL_UI_FLAG = "VFSA_LOCAL_SOURCING_UI";

export function localSourcingEnabled(env: Record<string, string | undefined> = process.env): boolean {
  return env[LOCAL_UI_FLAG] === "1" && env.NODE_ENV !== "production";
}

const LOOPBACK_HOST = /^(localhost|127\.0\.0\.1|\[::1\])(:\d{1,5})?$/i;

export function isLoopbackHost(host: string | null): boolean {
  return host !== null && LOOPBACK_HOST.test(host.trim());
}

/**
 * For route handlers: a JSON error response when access is not allowed,
 * otherwise null. Mutations also require a same-origin loopback Origin header,
 * so another web page cannot submit a cross-site form to the local server.
 */
export function denyUnlessLocal(request: Request, { mutation = false }: { mutation?: boolean } = {}): Response | null {
  if (!localSourcingEnabled()) {
    return Response.json(
      { error: "local_sourcing_disabled", message: `Local sourcing data is disabled. Set ${LOCAL_UI_FLAG}=1 for local development; it is never served in production.` },
      { status: 403, headers: { "Cache-Control": "no-store" } },
    );
  }
  const host = request.headers.get("host");
  if (!isLoopbackHost(host)) {
    return Response.json({ error: "not_local", message: "Local sourcing endpoints only answer loopback requests." }, { status: 403, headers: { "Cache-Control": "no-store" } });
  }
  if (mutation) {
    const origin = request.headers.get("origin");
    let originHost: string | null = null;
    try {
      originHost = origin ? new URL(origin).host : null;
    } catch {
      originHost = null;
    }
    if (!originHost || originHost !== host || !isLoopbackHost(originHost)) {
      return Response.json({ error: "cross_origin", message: "This action must come from the local sourcing interface." }, { status: 403, headers: { "Cache-Control": "no-store" } });
    }
  }
  return null;
}

/** Repository root: VFSA_REPO_ROOT, or the nearest folder above cwd with pnpm-workspace.yaml. */
export function repoRoot(env: Record<string, string | undefined> = process.env): string {
  if (env.VFSA_REPO_ROOT) return resolve(env.VFSA_REPO_ROOT);
  let dir = process.cwd();
  for (;;) {
    if (existsSync(join(dir, "pnpm-workspace.yaml"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return resolve(process.cwd(), "../..");
    dir = parent;
  }
}

/** Private data folders, all under the git-ignored evals/local/. */
export function localPaths(root: string = repoRoot()) {
  const local = join(root, "evals/local");
  return {
    root,
    predictions: join(local, "predictions"),
    imagesMap: join(local, "images.json"),
    candidates: join(local, "candidates"),
    shortlists: join(local, "shortlists"),
    verifications: join(local, "verifications"),
    sourcingRuns: join(local, "sourcing-runs"),
    uploads: join(local, "uploads"),
  };
}
