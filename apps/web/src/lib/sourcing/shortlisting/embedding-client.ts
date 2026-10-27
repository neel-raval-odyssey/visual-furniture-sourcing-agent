import { spawn } from "node:child_process";
import {
  embedErrorResponseSchema,
  EmbeddingProtocolError,
  EmbeddingServiceError,
  environmentResponseSchema,
  validateEmbedResponse,
  type EmbedOkResponse,
  type EmbedRequest,
  type EnvironmentResponse,
} from "./protocol";

/**
 * Boundary to the local image-embedding component. The shortlist command
 * depends on this interface so tests can substitute it; the real
 * implementation runs `python -m vfsa_vision` as a bounded child process.
 */
export interface ImageSimilarityRunner {
  /** Embeds the reference and candidate images and returns validated cosine similarities. */
  embed(request: EmbedRequest): Promise<EmbedOkResponse>;
  /** Runtime, device and cache status. Loads no model weights and downloads nothing. */
  environment(model: { id: string; revision: string | null }): Promise<EnvironmentResponse>;
}

export interface PythonRunnerOptions {
  /** Python executable of the project-local virtual environment. */
  python: string;
  /** services/vision: working directory, so `-m vfsa_vision` resolves to this repository's package. */
  serviceDir: string;
  timeoutMs?: number;
  /** Receives the child's stderr lines (diagnostics, never results). */
  onDiagnostic?: (line: string) => void;
}

const MAX_STDOUT_BYTES = 8 * 1024 * 1024;
export const DEFAULT_EMBED_TIMEOUT_MS = 10 * 60 * 1000;

interface ProcessResult {
  exitCode: number | null;
  stdout: string;
}

/** Only what Python needs; API keys and other secrets in the parent environment are not passed on. */
function childEnvironment(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const key of ["PATH", "HOME", "TMPDIR", "LANG", "LC_ALL"]) {
    const value = process.env[key];
    if (value) env[key] = value;
  }
  return {
    ...env,
    PYTHONDONTWRITEBYTECODE: "1",
    PYTHONUNBUFFERED: "1",
    HF_HUB_OFFLINE: "1",
    TRANSFORMERS_OFFLINE: "1",
    HF_HUB_DISABLE_TELEMETRY: "1",
  };
}

export class PythonImageSimilarityRunner implements ImageSimilarityRunner {
  constructor(private readonly options: PythonRunnerOptions) {}

  private run(args: string[], stdin: string | null, timeoutMs: number): Promise<ProcessResult> {
    const { python, serviceDir, onDiagnostic } = this.options;
    return new Promise((resolvePromise, reject) => {
      const child = spawn(python, args, {
        cwd: serviceDir,
        // NodeJS.ProcessEnv is augmented by Next.js to require NODE_ENV, which Python does not need.
        env: childEnvironment() as unknown as NodeJS.ProcessEnv,
        stdio: ["pipe", "pipe", "pipe"],
      });
      const out: Buffer[] = [];
      let outBytes = 0;
      let errTail = "";
      let settled = false;
      const finish = (fn: () => void) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        fn();
      };
      const timer = setTimeout(() => {
        child.kill("SIGKILL");
        finish(() => reject(new EmbeddingServiceError("timeout", `The embedding component did not finish within ${timeoutMs} ms`, null)));
      }, timeoutMs);

      child.on("error", (error: NodeJS.ErrnoException) => {
        const message =
          error.code === "ENOENT"
            ? "The Python environment for services/vision was not found. Set it up first (see services/vision/README.md)."
            : "The embedding component could not be started";
        finish(() => reject(new EmbeddingServiceError("python_unavailable", message, null)));
      });
      child.stdout.on("data", (chunk: Buffer) => {
        outBytes += chunk.length;
        if (outBytes > MAX_STDOUT_BYTES) {
          child.kill("SIGKILL");
          finish(() => reject(new EmbeddingProtocolError("The embedding component produced too much output")));
          return;
        }
        out.push(chunk);
      });
      child.stderr.on("data", (chunk: Buffer) => {
        const lines = (errTail + chunk.toString("utf8")).split("\n");
        errTail = lines.pop() ?? "";
        for (const line of lines) if (line.trim()) onDiagnostic?.(line);
      });
      child.on("close", (exitCode) => {
        if (errTail.trim()) onDiagnostic?.(errTail);
        finish(() => resolvePromise({ exitCode, stdout: Buffer.concat(out).toString("utf8") }));
      });
      child.stdin.on("error", () => {
        // The child exited before reading stdin; its exit status is reported on close.
      });
      child.stdin.end(stdin ?? "");
    });
  }

  private static parse(stdout: string): unknown {
    const text = stdout.trim();
    if (!text) return undefined;
    try {
      return JSON.parse(text);
    } catch {
      throw new EmbeddingProtocolError("The embedding component did not return valid JSON on stdout");
    }
  }

  private static failure(raw: unknown, exitCode: number | null): Error {
    const error = embedErrorResponseSchema.safeParse(raw);
    if (error.success) return new EmbeddingServiceError(error.data.error.code, error.data.error.message, exitCode);
    if (raw === undefined) return new EmbeddingServiceError("process_failed", `The embedding component exited with code ${exitCode} and no result`, exitCode);
    return new EmbeddingProtocolError(`The embedding component exited with code ${exitCode} and an unrecognized result`);
  }

  async embed(request: EmbedRequest): Promise<EmbedOkResponse> {
    const { exitCode, stdout } = await this.run(["-m", "vfsa_vision", "embed"], JSON.stringify(request), this.options.timeoutMs ?? DEFAULT_EMBED_TIMEOUT_MS);
    const raw = PythonImageSimilarityRunner.parse(stdout);
    if (exitCode !== 0) throw PythonImageSimilarityRunner.failure(raw, exitCode);
    if (raw === undefined) throw new EmbeddingProtocolError("The embedding component returned no result");
    return validateEmbedResponse(request, raw);
  }

  async environment(model: { id: string; revision: string | null }): Promise<EnvironmentResponse> {
    const args = ["-m", "vfsa_vision", "environment", "--model", model.id];
    if (model.revision) args.push("--revision", model.revision);
    const { exitCode, stdout } = await this.run(args, null, 120_000);
    const raw = PythonImageSimilarityRunner.parse(stdout);
    if (exitCode !== 0) throw PythonImageSimilarityRunner.failure(raw, exitCode);
    const parsed = environmentResponseSchema.safeParse(raw);
    if (!parsed.success) throw new EmbeddingProtocolError("The environment check returned an unrecognized result");
    return parsed.data;
  }
}
