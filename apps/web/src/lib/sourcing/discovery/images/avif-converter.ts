import { execFile } from "node:child_process";
import { join } from "node:path";

/**
 * AVIF → PNG through the local vision component (services/vision), which
 * decodes the image and re-encodes it as PNG after checking its hash. The
 * file is never just renamed. Only PATH is passed to Python.
 */
export function pythonAvifConverter(repoRoot: string) {
  const serviceDir = join(repoRoot, "services/vision");
  const python = join(serviceDir, ".venv/bin/python");
  return (avifPath: string, sha256: string, pngPath: string) =>
    new Promise<void>((resolvePromise, reject) => {
      execFile(
        python,
        ["-m", "vfsa_vision", "convert", "--input", avifPath, "--sha256", sha256, "--output", pngPath],
        {
          cwd: serviceDir,
          timeout: 60_000,
          encoding: "utf8",
          // Only what Python needs; NodeJS.ProcessEnv is augmented by Next.js to require NODE_ENV.
          env: { PATH: process.env.PATH ?? "", PYTHONDONTWRITEBYTECODE: "1" } as unknown as NodeJS.ProcessEnv,
        },
        (error: Error | null, stdout: string) => {
          if (!error) return resolvePromise();
          let message = "AVIF conversion failed";
          try {
            message = (JSON.parse(stdout) as { error?: { message?: string } }).error?.message ?? message;
          } catch {
            // keep the generic message
          }
          reject(new Error(message));
        },
      );
    });
}
