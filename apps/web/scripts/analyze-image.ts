/**
 * Local CLI: `pnpm analyze:image --file <path> [--live] [--json]`.
 * Loads apps/web/.env* via @next/env, then delegates to runAnalyzeImageCli.
 */
import { loadEnvConfig } from "@next/env";
import { resolve } from "node:path";
import { runAnalyzeImageCli } from "../src/lib/sourcing/cli/analyze-image";

const appDir = resolve(__dirname, "..");

// Silence "Loaded env from <absolute path>" messages; keep errors.
loadEnvConfig(appDir, true, { info: () => {}, error: (...args: unknown[]) => console.error(...args) });

runAnalyzeImageCli(process.argv.slice(2), {
  env: process.env,
  // pnpm runs workspace scripts from apps/web; resolve paths from where the user ran pnpm.
  cwd: process.env.INIT_CWD ?? process.cwd(),
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
