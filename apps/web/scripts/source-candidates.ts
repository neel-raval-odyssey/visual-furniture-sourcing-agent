/**
 * Operator-assisted Alibaba.com candidate intake: `pnpm source:candidates`.
 * Reads and writes local files only; it does not load env files or contact
 * any service.
 */
import { resolve } from "node:path";
import { runSourceCandidatesCli } from "../src/lib/sourcing/cli/source-candidates";

runSourceCandidatesCli(process.argv.slice(2), {
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
