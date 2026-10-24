/**
 * Offline evaluator CLI: `pnpm eval:images [options]`. Reads files only; it
 * does not load env files or contact any API.
 */
import { resolve } from "node:path";
import { runEvalImagesCli } from "../src/lib/sourcing/cli/eval-images";

runEvalImagesCli(process.argv.slice(2), {
  // pnpm runs workspace scripts from apps/web; resolve paths from where the user ran pnpm.
  cwd: process.env.INIT_CWD ?? process.cwd(),
  repoRoot: resolve(__dirname, "../../.."),
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
