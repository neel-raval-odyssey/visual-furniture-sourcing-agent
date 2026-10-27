/**
 * Automated sourcing orchestration: `pnpm source:auto`. Offline only: it reads
 * local records and may run the local SigLIP 2 component; it loads no env
 * files and makes no marketplace, image-download or paid model request.
 */
import { resolve } from "node:path";
import { runSourceAutoCli } from "../src/lib/sourcing/cli/source-auto";

runSourceAutoCli(process.argv.slice(2), {
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
