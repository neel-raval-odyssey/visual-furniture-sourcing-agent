/**
 * Detailed visual verification: `pnpm verify:visual`. Loads apps/web/.env*
 * via @next/env (for OPENAI_API_KEY, used only with --live), then delegates to
 * runVerifyVisualCli. Without --live nothing is sent.
 */
import { loadEnvConfig } from "@next/env";
import { resolve } from "node:path";
import { runVerifyVisualCli } from "../src/lib/sourcing/cli/verify-visual";

const appDir = resolve(__dirname, "..");

// Silence "Loaded env from <absolute path>" messages; keep errors.
loadEnvConfig(appDir, true, { info: () => {}, error: (...args: unknown[]) => console.error(...args) });

runVerifyVisualCli(process.argv.slice(2), {
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
