import type { FurnitureFingerprint, ReferenceImage } from "../../domain";

/**
 * SYNTHETIC FIXTURE DATA. These reference images and fingerprints are
 * invented for pipeline testing. The fingerprints were written by hand; no
 * image was analysed to produce them. URLs use the reserved example.com domain.
 */

const BASE_URL = "https://example.com/mock-references";

export const MOCK_REFERENCE_IMAGES = {
  chair: {
    id: "mock-ref-chair-001",
    image: { uri: `${BASE_URL}/chair-001.jpg`, mimeType: "image/jpeg" },
    origin: { kind: "social_media", platform: "Synthetic Social (Mock)" },
    sourceUrl: `${BASE_URL}/posts/chair-001`,
    submittedAt: "2026-01-01T00:00:00.000Z",
  },
  table: {
    id: "mock-ref-table-001",
    image: { uri: `${BASE_URL}/table-001.jpg`, mimeType: "image/jpeg" },
    origin: { kind: "catalogue" },
    submittedAt: "2026-01-01T00:00:00.000Z",
    catalogue: { title: "Synthetic Catalogue (Mock)", pageNumber: 14 },
  },
  /** A supported reference whose category has no fixture listings. */
  bed: {
    id: "mock-ref-bed-001",
    image: { uri: `${BASE_URL}/bed-001.jpg` },
    origin: { kind: "personal_photo" },
    submittedAt: "2026-01-01T00:00:00.000Z",
  },
} as const satisfies Record<string, ReferenceImage>;

const FIXTURE_CREATED_AT = "2026-01-01T00:00:00.000Z";

export const MOCK_FINGERPRINTS: readonly FurnitureFingerprint[] = [
  {
    id: "mock-fp-chair-001",
    referenceImageIds: [MOCK_REFERENCE_IMAGES.chair.id],
    category: "chair",
    subtype: "dining_chair",
    structure: [
      { attribute: "leg_count", value: "4", certainty: "observed" },
      { attribute: "back_shape", value: "curved", certainty: "observed" },
      { attribute: "arms", value: "none", certainty: "observed" },
    ],
    appearance: [
      { attribute: "frame_colour", value: "black", certainty: "observed" },
      {
        attribute: "frame_material",
        value: "metal",
        certainty: "inferred",
        rationale: "Thin, uniform tubular profile; could be painted wood.",
      },
      {
        attribute: "backrest_material",
        value: "wood",
        certainty: "inferred",
        rationale: "Visible grain pattern; could be veneer or print.",
      },
      {
        attribute: "wood_species",
        certainty: "unknown",
        rationale: "Not determinable from a photograph.",
      },
    ],
    distinctiveFeatures: [
      { attribute: "backrest", value: "single curved panel", certainty: "observed" },
    ],
    searchQueries: ["dining chair", "lounge chair"],
    source: { kind: "fixture", dataSource: "mock" },
    createdAt: FIXTURE_CREATED_AT,
  },
  {
    id: "mock-fp-table-001",
    referenceImageIds: [MOCK_REFERENCE_IMAGES.table.id],
    category: "table",
    subtype: "dining_table",
    structure: [
      { attribute: "top_shape", value: "round", certainty: "observed" },
      { attribute: "base", value: "central pedestal", certainty: "observed" },
      {
        attribute: "diameter",
        certainty: "unknown",
        rationale: "No reference object for scale.",
      },
    ],
    appearance: [
      { attribute: "top_colour", value: "light oak tone", certainty: "observed" },
      {
        attribute: "top_material",
        value: "wood veneer",
        certainty: "inferred",
        rationale: "Uniform grain suggests veneer rather than solid wood.",
      },
    ],
    distinctiveFeatures: [
      { attribute: "pedestal", value: "flared trumpet base", certainty: "observed" },
    ],
    searchQueries: ["dining table", "coffee table"],
    source: { kind: "fixture", dataSource: "mock" },
    createdAt: FIXTURE_CREATED_AT,
  },
  {
    id: "mock-fp-bed-001",
    referenceImageIds: [MOCK_REFERENCE_IMAGES.bed.id],
    category: "bed",
    subtype: "canopy_bed",
    structure: [{ attribute: "posts", value: "4", certainty: "observed" }],
    appearance: [
      { attribute: "frame_colour", value: "white", certainty: "observed" },
    ],
    distinctiveFeatures: [],
    searchQueries: ["canopy bed"],
    source: { kind: "fixture", dataSource: "mock" },
    createdAt: FIXTURE_CREATED_AT,
  },
];
