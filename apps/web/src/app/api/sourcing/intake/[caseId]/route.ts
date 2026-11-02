import { completeIntake, IntakeProblem, MAX_PRODUCT_IMAGE_BYTES, removeEntry, saveEntry, startIntake } from "@/lib/sourcing/ui/intake/intake";
import { CASE_ID } from "@/lib/sourcing/ui/data";
import { discardDraft, setEntryImage, startRevision } from "@/lib/sourcing/ui/intake/revision";
import { denyUnlessLocal, localPaths } from "@/lib/sourcing/ui/local-access";

export const runtime = "nodejs";

type Params = { params: Promise<{ caseId: string }> };

const STATUS: Record<IntakeProblem["code"], number> = {
  invalid_case: 400,
  not_ready: 409,
  collection_exists: 409,
  no_draft: 404,
  completed: 409,
  invalid_field: 422,
  duplicate: 409,
  too_many: 409,
  invalid_image: 422,
  unknown_entry: 404,
  empty: 422,
  changed: 409,
  stale: 409,
  not_revisable: 409,
};

/**
 * Operator-assisted product intake for one reference (multipart form):
 * action=start | revise | save | photo | remove | complete | discard. Records what a person found on
 * Alibaba.com's own website; this route searches and downloads nothing.
 */
export async function POST(request: Request, { params }: Params) {
  const denied = denyUnlessLocal(request, { mutation: true });
  if (denied) return denied;
  const { caseId } = await params;
  if (!CASE_ID.test(caseId)) return Response.json({ error: "invalid_case" }, { status: 400 });
  const declared = Number(request.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > MAX_PRODUCT_IMAGE_BYTES + 256 * 1024) {
    return Response.json({ error: "invalid_image", message: "The photo is larger than 10 MB.", field: "image" }, { status: 413 });
  }
  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return Response.json({ error: "invalid_request", message: "Send the form as multipart form data." }, { status: 400 });
  }
  const text = (k: string) => {
    const v = form.get(k);
    return typeof v === "string" ? v : null;
  };
  const paths = localPaths();
  const intakeId = text("intakeId") ?? "";
  try {
    switch (text("action")) {
      case "start": {
        const session = await startIntake(paths, caseId);
        return Response.json({ ok: true, intakeId: session.intakeId, revision: session.revision }, { status: 201 });
      }
      case "save": {
        const file = form.get("file");
        const image = file instanceof File && file.size > 0 ? { bytes: new Uint8Array(await file.arrayBuffer()), name: file.name } : null;
        if (file instanceof File && file.size > MAX_PRODUCT_IMAGE_BYTES) throw new IntakeProblem("invalid_image", "The photo is larger than 10 MB.", "image");
        const { session, entry } = await saveEntry(
          paths,
          caseId,
          intakeId,
          {
            entryId: text("entryId"),
            listingUrl: text("listingUrl") ?? "",
            title: text("title") ?? "",
            supplierName: text("supplierName"),
            supplierProfileUrl: text("supplierProfileUrl"),
            priceMin: text("priceMin"),
            priceMax: text("priceMax"),
            currency: text("currency"),
            priceUnit: text("priceUnit"),
            moqQuantity: text("moqQuantity"),
            moqUnit: text("moqUnit"),
            foundWith: text("foundWith"),
            queryUsed: text("queryUsed"),
            notes: text("notes"),
            removeImage: text("removeImage") === "1",
          },
          image,
        );
        return Response.json({ ok: true, entryId: entry.id, revision: session.revision });
      }
      case "revise": {
        const session = await startRevision(paths, caseId);
        return Response.json({ ok: true, intakeId: session.intakeId, revision: session.revision }, { status: 201 });
      }
      case "photo": {
        const file = form.get("file");
        if (!(file instanceof File) || file.size === 0) throw new IntakeProblem("invalid_image", "Choose a product photo.", "image");
        if (file.size > MAX_PRODUCT_IMAGE_BYTES) throw new IntakeProblem("invalid_image", "The photo is larger than 10 MB.", "image");
        const session = await setEntryImage(paths, caseId, intakeId, text("entryId") ?? "", { bytes: new Uint8Array(await file.arrayBuffer()), name: file.name });
        return Response.json({ ok: true, revision: session.revision });
      }
      case "discard": {
        await discardDraft(paths, caseId, intakeId);
        return Response.json({ ok: true });
      }
      case "remove": {
        const session = await removeEntry(paths, caseId, intakeId, text("entryId") ?? "");
        return Response.json({ ok: true, revision: session.revision });
      }
      case "complete": {
        const { summary } = await completeIntake(paths, caseId, intakeId);
        return Response.json({ ok: true, products: summary.products, withImage: summary.withImage });
      }
      default:
        return Response.json({ error: "invalid_request", message: "Unsupported action." }, { status: 400 });
    }
  } catch (error) {
    if (error instanceof IntakeProblem) return Response.json({ error: error.code, message: error.message, field: error.field }, { status: STATUS[error.code] });
    throw error;
  }
}
