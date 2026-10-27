import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PythonImageSimilarityRunner } from "./embedding-client";
import { DEFAULT_MODEL_ID, EmbeddingProtocolError, EmbeddingServiceError, PROTOCOL, PROTOCOL_VERSION, type EmbedRequest } from "./protocol";
import { fakeResponse, sha256 } from "./test-fixtures";

/**
 * Exercises the real child-process handling with a stand-in "python": a Node
 * script placed at <serviceDir>/vfsa_vision so that `-m vfsa_vision ...`
 * arguments reach it. No Python, model or network is involved.
 */

let dir: string;
const request: EmbedRequest = {
  protocol: PROTOCOL,
  protocolVersion: PROTOCOL_VERSION,
  model: { id: DEFAULT_MODEL_ID, revision: null },
  device: "cpu",
  reference: { id: "ref-1", path: "/abs/ref.png", sha256: sha256("ref") },
  groups: [{ id: "listing-a", images: [{ ref: "c/a.png", path: "/abs/a.png", sha256: sha256("a") }] }],
};

async function fakePython(name: string, body: string): Promise<string> {
  const path = join(dir, `${name}.mjs`);
  // argv: [node, script, "-m", "vfsa_vision", command, ...]
  await writeFile(path, `#!${process.execPath}\nconst input = await new Promise((r) => { let s = ""; process.stdin.on("data", (d) => (s += d)); process.stdin.on("end", () => r(s)); });\n${body}\n`, { mode: 0o755 });
  return path;
}

const runner = (python: string, extra: Partial<ConstructorParameters<typeof PythonImageSimilarityRunner>[0]> = {}) =>
  new PythonImageSimilarityRunner({ python, serviceDir: dir, ...extra });

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "vfsa-runner-"));
});
afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("Python embedding runner", () => {
  it("sends the request on stdin, returns the validated result and forwards stderr as diagnostics", async () => {
    const ok = JSON.stringify(fakeResponse(request, { "listing-a": 0.77 }));
    const python = await fakePython(
      "ok",
      `const req = JSON.parse(input); if (process.argv[4] !== "embed" || req.groups[0].id !== "listing-a") process.exit(9);
       if (process.env.OPENAI_API_KEY || process.env.HF_HUB_OFFLINE !== "1") process.exit(8);
       process.stderr.write("loading model\\n"); process.stdout.write(${JSON.stringify(ok)});`,
    );
    const diagnostics: string[] = [];
    process.env.OPENAI_API_KEY = "sk-test-not-forwarded";
    try {
      const res = await runner(python, { onDiagnostic: (l) => diagnostics.push(l) }).embed(request);
      expect(res.groups[0]).toMatchObject({ id: "listing-a", embeddingCosineSimilarity: 0.77 });
    } finally {
      delete process.env.OPENAI_API_KEY;
    }
    expect(diagnostics).toEqual(["loading model"]);
  });

  it("reports structured Python errors with their code", async () => {
    const python = await fakePython(
      "err",
      `process.stdout.write(JSON.stringify({ protocol: "${PROTOCOL}", protocolVersion: 1, status: "error", error: { code: "model_not_cached", message: "not cached" } })); process.exit(3);`,
    );
    const error = await runner(python).embed(request).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(EmbeddingServiceError);
    expect(error).toMatchObject({ code: "model_not_cached", exitCode: 3 });
  });

  it("rejects invalid JSON, crashes without output and inconsistent results", async () => {
    const garbage = await fakePython("garbage", `process.stdout.write("Loading weights... done\\nscore=0.9");`);
    await expect(runner(garbage).embed(request)).rejects.toBeInstanceOf(EmbeddingProtocolError);

    const crash = await fakePython("crash", `process.stderr.write("Traceback...\\n"); process.exit(1);`);
    await expect(runner(crash).embed(request)).rejects.toMatchObject({ code: "process_failed", exitCode: 1 });

    const wrong = JSON.stringify({ ...fakeResponse(request, { "listing-a": 0.5 }), model: { ...fakeResponse(request, {}).model, id: "google/siglip2-large-patch16-384" } });
    const mismatch = await fakePython("mismatch", `process.stdout.write(${JSON.stringify(wrong)});`);
    await expect(runner(mismatch).embed(request)).rejects.toThrow(/was not the requested/);
  });

  it("reports a missing Python environment and a timeout", async () => {
    await expect(runner(join(dir, "no-such-python")).embed(request)).rejects.toMatchObject({ code: "python_unavailable" });
    const slow = await fakePython("slow", `await new Promise((r) => setTimeout(r, 5000));`);
    await expect(runner(slow, { timeoutMs: 200 }).embed(request)).rejects.toMatchObject({ code: "timeout" });
  });
});
