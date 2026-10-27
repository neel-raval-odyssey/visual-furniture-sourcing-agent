import { denyUnlessLocal, localPaths } from "@/lib/sourcing/ui/local-access";
import { MAX_UPLOAD_BYTES, stageUpload, UploadRejected } from "@/lib/sourcing/ui/uploads";

export const runtime = "nodejs";

/**
 * Stages a new reference photo privately. No analysis, search or external
 * upload happens: the response says the photo awaits image understanding.
 */
export async function POST(request: Request) {
  const denied = denyUnlessLocal(request, { mutation: true });
  if (denied) return denied;
  const declared = Number(request.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > MAX_UPLOAD_BYTES + 64 * 1024) {
    return Response.json({ error: "too_large", message: "The file is larger than 10 MB." }, { status: 413 });
  }
  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return Response.json({ error: "invalid_request", message: "Send the photo as multipart form data in a field named \"file\"." }, { status: 400 });
  }
  const file = form.get("file");
  if (!(file instanceof File)) return Response.json({ error: "invalid_request", message: "No file was provided." }, { status: 400 });
  if (file.size > MAX_UPLOAD_BYTES) return Response.json({ error: "too_large", message: "The file is larger than 10 MB." }, { status: 413 });
  try {
    const record = await stageUpload(localPaths(), new Uint8Array(await file.arrayBuffer()), file.name);
    return Response.json(
      { id: record.id, status: record.status, width: record.width, height: record.height, sha256: record.sha256, uploadedAt: record.uploadedAt },
      { status: 201, headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    if (error instanceof UploadRejected) return Response.json({ error: error.code, message: error.message }, { status: error.code === "too_large" ? 413 : 422 });
    throw error;
  }
}
