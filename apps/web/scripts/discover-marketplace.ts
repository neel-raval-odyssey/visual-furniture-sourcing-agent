/**
 * Automated marketplace discovery: `pnpm discover:marketplace`. Loads
 * apps/web/.env* via @next/env (for APIFY_TOKEN, used only by --live,
 * --resume and --fetch-images), then delegates to runDiscoverMarketplaceCli.
 * Without --live nothing is sent.
 */
import { loadEnvConfig } from "@next/env";
import { resolve } from "node:path";
import { runDiscoverMarketplaceCli } from "../src/lib/sourcing/cli/discover-marketplace";

const appDir = resolve(__dirname, "..");

// Silence "Loaded env from <absolute path>" messages; keep errors.
loadEnvConfig(appDir, true, { info: () => {}, error: (...args: unknown[]) => console.error(...args) });

runDiscoverMarketplaceCli(process.argv.slice(2), {
  env: process.env,
  // pnpm runs workspace scripts from apps/web; resolve paths from where the user ran pnpm.
  cwd: process.env.INIT_CWD ?? process.cwd(),
  repoRoot: resolve(appDir, "../.."),
  io: { out: (line) => console.log(line), err: (line) => console.error(line) },
}).then(
  (code) => {
    process.exitCode = code;
  },
  (error: unknown) => {
    console.error(`Unexpected failure: ${error instanceof Error ? error.name : "unknown error"}`);
    process.exitCode = 1;
  },
);
