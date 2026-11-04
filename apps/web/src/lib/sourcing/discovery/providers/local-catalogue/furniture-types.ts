import type { FurnitureFingerprint } from "../../../domain";

/**
 * Furniture-type matching for the local catalogue. A small, explicit
 * vocabulary of common marketplace phrasings: each saved product title (or its
 * recorded category) is mapped to one furniture type, and so is the saved
 * photo analysis. Only the same type, or an explicitly related one (a side
 * table for a coffee table), is offered; anything else is excluded with its
 * reason. Text that names no known type is reported as unrecognised, never
 * guessed. Visual ranking is left entirely to SigLIP 2.
 */

export type FurnitureType =
  | "bed"
  | "daybed"
  | "sofa_bed"
  | "nightstand"
  | "coffee_table"
  | "side_table"
  | "console_table"
  | "dining_table"
  | "desk"
  | "table"
  | "sofa"
  | "chair"
  | "stool"
  | "ottoman"
  | "bench"
  | "wardrobe"
  | "cabinet"
  | "shelf";

/** Phrases per type, as whole words. Longer, more specific phrases are tried before generic ones. */
const PHRASES: [FurnitureType, string[]][] = [
  ["nightstand", ["bedside table", "bedside cabinet", "bedside", "night stand", "nightstand", "night table"]],
  ["sofa_bed", ["sofa bed", "sofabed", "sofa cum bed", "futon"]],
  ["daybed", ["day bed", "daybed"]],
  ["coffee_table", ["coffee table", "tea table", "cocktail table", "centre table", "center table", "nesting table", "nest of tables"]],
  ["side_table", ["side table", "end table", "accent table", "lamp table"]],
  ["console_table", ["console table", "sofa table", "hall table", "entryway table"]],
  ["dining_table", ["dining table", "dinner table", "kitchen table"]],
  ["desk", ["desk", "study table", "writing table", "computer table", "office table"]],
  ["sofa", ["sofa", "couch", "settee", "loveseat", "love seat", "sectional"]],
  ["chair", ["armchair", "arm chair", "lounge chair", "dining chair", "accent chair", "chair", "recliner"]],
  ["stool", ["stool", "barstool"]],
  ["ottoman", ["ottoman", "pouf", "pouffe", "footstool"]],
  ["bench", ["bench"]],
  ["wardrobe", ["wardrobe", "armoire", "closet"]],
  ["cabinet", ["sideboard", "cabinet", "dresser", "chest of drawers", "credenza", "buffet"]],
  ["shelf", ["bookshelf", "bookcase", "shelf", "shelving"]],
  ["bed", ["bed frame", "bedframe", "bedstead", "platform bed", "bed"]],
  ["table", ["table"]],
];

const TABLES: FurnitureType[] = ["coffee_table", "side_table", "console_table", "dining_table", "desk", "table", "nightstand"];

/** Types offered for a reference type besides the same type, with the reason shown to the reader. */
const RELATED: Partial<Record<FurnitureType, FurnitureType[]>> = {
  coffee_table: ["side_table", "table"],
  side_table: ["coffee_table", "nightstand", "table"],
  nightstand: ["side_table"],
  console_table: ["table"],
  dining_table: ["table"],
  desk: ["table"],
  table: TABLES.filter((t) => t !== "table"),
  daybed: ["sofa_bed", "bed"],
  sofa_bed: ["sofa", "daybed"],
  sofa: ["sofa_bed"],
  stool: ["ottoman"],
  ottoman: ["stool"],
};

const normalize = (text: string) => ` ${text.toLowerCase().replace(/[_/]+/g, " ").replace(/[^a-z0-9]+/g, " ").replace(/\s+/g, " ").trim()} `;

/** Every type named in the text, with the position of its first mention (plural "s"/"es" allowed). */
function mentions(text: string): { type: FurnitureType; phrase: string; at: number }[] {
  const t = normalize(text);
  const found: { type: FurnitureType; phrase: string; at: number }[] = [];
  const taken: [number, number][] = [];
  for (const [type, phrases] of PHRASES) {
    for (const phrase of phrases) {
      const re = new RegExp(` ${phrase}(?:e?s)?(?= )`, "g");
      for (const m of t.matchAll(re)) {
        const start = m.index!;
        const end = start + m[0].length;
        // A phrase already claimed by a more specific one ("bedside table" vs "table") is not counted again.
        if (taken.some(([a, b]) => start < b - 1 && end - 1 > a)) continue;
        taken.push([start, end]);
        found.push({ type, phrase, at: start });
      }
    }
  }
  return found.sort((a, b) => a.at - b.at);
}

/**
 * The furniture type a product title names: the first type mentioned, since
 * marketplace titles lead with the product ("…Bed with Arched Headboard").
 */
export function classifyText(text: string): { type: FurnitureType; phrase: string } | null {
  const first = mentions(text)[0];
  return first ? { type: first.type, phrase: first.phrase } : null;
}

/** Type of a saved product: its title, else its recorded category. */
export function classifyProduct(p: { title: string; category?: string | null }): { type: FurnitureType; phrase: string; from: "title" | "category" } | null {
  const byTitle = classifyText(p.title);
  if (byTitle) return { ...byTitle, from: "title" };
  const byCategory = p.category ? classifyText(p.category) : null;
  return byCategory ? { ...byCategory, from: "category" } : null;
}

/**
 * Type of the analysed furniture: the subtype ("nesting_coffee_table_set")
 * when it names one, else the category ("table"), else the saved search
 * queries' most frequent type.
 */
export function referenceType(fp: Pick<FurnitureFingerprint, "category" | "subtype" | "searchQueries">): { type: FurnitureType; phrase: string; from: "subtype" | "category" | "queries" } | null {
  const sub = fp.subtype ? classifyText(fp.subtype) : null;
  if (sub && sub.type !== "table") return { ...sub, from: "subtype" };
  const cat = classifyText(fp.category);
  if (cat && cat.type !== "table") return { ...cat, from: "category" };
  const counts = new Map<FurnitureType, { n: number; phrase: string }>();
  for (const q of fp.searchQueries) {
    const c = classifyText(q);
    if (c) counts.set(c.type, { n: (counts.get(c.type)?.n ?? 0) + 1, phrase: c.phrase });
  }
  const best = [...counts.entries()].sort((a, b) => b[1].n - a[1].n)[0];
  if (best && best[0] !== "table") return { type: best[0], phrase: best[1].phrase, from: "queries" };
  if (sub) return { ...sub, from: "subtype" };
  if (cat) return { ...cat, from: "category" };
  return best ? { type: best[0], phrase: best[1].phrase, from: "queries" } : null;
}

export type TypeMatch = "same_type" | "related_type" | "different_type";

export function compareTypes(reference: FurnitureType, product: FurnitureType): TypeMatch {
  if (reference === product) return "same_type";
  return RELATED[reference]?.includes(product) ? "related_type" : "different_type";
}

export const humanType = (t: FurnitureType) => t.replace(/_/g, " ");

const STOP = new Set(
  "a an and are as at be but by for from has have in into is it its looks may of on or rather than that the their them these this to toward towards very with without each two one visible slightly appearance style styling design designs modern furniture set sets piece pieces like similar".split(
    " ",
  ),
);

/** Distinct descriptive words from the saved queries and recorded (observed or inferred) attribute values. */
export function referenceTerms(fp: Pick<FurnitureFingerprint, "searchQueries" | "structure" | "appearance" | "distinctiveFeatures">): string[] {
  const texts = [...fp.searchQueries, ...[...fp.structure, ...fp.appearance, ...fp.distinctiveFeatures].flatMap((f) => (f.certainty === "unknown" ? [] : [f.value]))];
  const words = new Set<string>();
  for (const t of texts) for (const w of normalize(t).trim().split(" ")) if (w.length > 2 && !STOP.has(w) && !/^\d+$/.test(w)) words.add(w);
  return [...words];
}

/** Which reference terms a product title contains (whole words, singular or plural). */
export function matchedTerms(title: string, terms: readonly string[]): string[] {
  const words = new Set(normalize(title).trim().split(" ").flatMap((w) => [w, w.replace(/e?s$/, "")]));
  return terms.filter((t) => words.has(t) || words.has(t.replace(/e?s$/, "")));
}
