/**
 * Automatic product discovery: `pnpm discover:products`. Loads
 * apps/web/.env* via @next/env (for EXA_API_KEY, used only by --live and
 * --resume --live), then delegates to runDiscoverProductsCli.
 * Without --live nothing is sent.
 */
import { loadEnvConfig } from "@next/env";
import { resolve } from "node:path";
import { runDiscoverProductsCli } from "../src/lib/sourcing/cli/discover-products";

const appDir = resolve(__dirname, "..");

// Silence "Loaded env from <absolute path>" messages; keep errors.
loadEnvConfig(appDir, true, { info: () => {}, error: (...args: unknown[]) => console.error(...args) });

runDiscoverProductsCli(process.argv.slice(2), {
  env: process.env,
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
