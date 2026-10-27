import { deflateSync } from "node:zlib";
import { crc32 } from "../../image-input/inspect";
import type { RawVisualVerification } from "./raw-response";

/**
 * TEST FIXTURES: synthetic images built in memory and hand-written raw
 * verification outputs. None of them is real GPT-6.1 Sol output, and none
 * encodes an expected ranking of real candidates.
 */

function chunk(type: string, data: Uint8Array): Buffer {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "ascii"), Buffer.from(data)]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
}

/** A valid RGB PNG of one colour; `shade` makes the bytes (and hash) distinct. */
export function makePng(width = 32, height = 24, shade = 0): Buffer {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr.set([8, 2, 0, 0, 0], 8);
  const row = Buffer.alloc(1 + width * 3, shade & 0xff);
  row[0] = 0;
  const raw = Buffer.concat(Array.from({ length: height }, () => row));
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw)),
    chunk("IEND", new Uint8Array()),
  ]);
}

/** Structurally valid baseline JPEG container (frame header, scan, end marker). */
export function makeJpeg(width = 40, height = 30): Buffer {
  const sof = Buffer.from([0xff, 0xc0, 0x00, 0x11, 0x08, height >> 8, height & 0xff, width >> 8, width & 0xff, 0x03, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1]);
  const sos = Buffer.from([0xff, 0xda, 0x00, 0x0c, 0x03, 1, 0x00, 2, 0x11, 3, 0x11, 0x00, 0x3f, 0x00]);
  return Buffer.concat([Buffer.from([0xff, 0xd8]), sof, sos, Buffer.from([0x12, 0x34, 0x56]), Buffer.from([0xff, 0xd9])]);
}

/** Structurally valid lossless WebP (VP8L) container header. */
export function makeWebp(width = 50, height = 20): Buffer {
  const bits = ((width - 1) & 0x3fff) | (((height - 1) & 0x3fff) << 14);
  const payload = Buffer.alloc(20);
  payload[0] = 0x2f;
  payload.writeUInt32LE(bits >>> 0, 1);
  const vp8l = Buffer.concat([Buffer.from("VP8L"), Buffer.from([payload.length, 0, 0, 0]), payload]);
  const body = Buffer.concat([Buffer.from("WEBP"), vp8l]);
  const size = Buffer.alloc(4);
  size.writeUInt32LE(body.length);
  return Buffer.concat([Buffer.from("RIFF"), size, body]);
}

const target = { identifiable: true, category: "bed", note: "[TEST] One bed is the subject." };

/** Internally consistent synthetic output (close_variant, index 78). */
export function syntheticRawVerification(overrides: Partial<RawVisualVerification> = {}): RawVisualVerification {
  return {
    reference_target: target,
    candidate_target: target,
    category_comparison: "same_category",
    features: [
      {
        feature: "Headboard Arch Count",
        aspect: "structural_geometry",
        importance: "defining",
        reference_observation: "[TEST] seven narrow arches",
        candidate_observation: "[TEST] six narrow arches",
        comparison: "partial_match",
        evidence_basis: "observed",
        visibility_limitation: null,
        explanation: "[TEST] Same arch motif, one fewer arch.",
      },
      {
        feature: "headboard_top_rail",
        aspect: "structural_geometry",
        importance: "supporting",
        reference_observation: "[TEST] projecting top rail",
        candidate_observation: "[TEST] projecting top rail",
        comparison: "match",
        evidence_basis: "observed",
        visibility_limitation: null,
        explanation: "[TEST] Both have a projecting rail.",
      },
      {
        feature: "leg_profile",
        aspect: "structural_geometry",
        importance: "supporting",
        reference_observation: "[TEST] short turned feet",
        candidate_observation: "[TEST] square legs",
        comparison: "mismatch",
        evidence_basis: "observed",
        visibility_limitation: null,
        explanation: "[TEST] Different foot profile.",
      },
      {
        feature: "side_rails",
        aspect: "structural_geometry",
        importance: "minor",
        reference_observation: null,
        candidate_observation: null,
        comparison: "not_comparable",
        evidence_basis: "not_visible",
        visibility_limitation: "[TEST] Covered by bedding",
        explanation: "[TEST] Hidden in both images.",
      },
    ],
    visibility_limitations: ["[TEST] Candidate photographed in a furnished room"],
    uncertain_claims: ["[TEST] Finish sheen"],
    summary: "[TEST] Same arched-panel idea with a different arch count and feet.",
    classification: "close_variant",
    design_similarity_index: 78,
    confidence: "medium",
    ...overrides,
  };
}

/** A fake Responses API result carrying `raw` as parsed output. */
export function fakeApiResponse(raw: RawVisualVerification | null, overrides: Record<string, unknown> = {}) {
  return {
    id: "resp_test_123",
    model: "gpt-6.1-sol-2026-10-01",
    status: "completed",
    _request_id: "req_test_1",
    output: [{ type: "message", content: [{ type: "output_text", text: "{}", parsed: raw }] }],
    output_parsed: raw,
    usage: { input_tokens: 2100, output_tokens: 900, total_tokens: 3000, output_tokens_details: { reasoning_tokens: 400 } },
    ...overrides,
  };
}
