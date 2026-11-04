import { describe, expect, it } from "vitest";
import { classifyProduct, classifyText, compareTypes, matchedTerms, referenceTerms, referenceType } from "./furniture-types";

/** Titles phrased the way Alibaba.com listings are (written for the test, not copied from any listing). */
describe("furniture types", () => {
  it("reads the product type from marketplace-style titles, leading product first", () => {
    expect(classifyText("[TEST] Classic Solid Wood Platform Bed with Arched Headboard")?.type).toBe("bed");
    expect(classifyText("[TEST] Wooden King Size Bed Frame Solid Wood Queen")?.type).toBe("bed");
    expect(classifyText("[TEST] Modern Solid Wood Tea Tables Living Room Furniture")?.type).toBe("coffee_table");
    expect(classifyText("[TEST] Smart Wood Side Coffee Table with USB Charging")?.type).toBe("coffee_table");
    expect(classifyText("[TEST] Nordic Nesting Tables Set of 2")?.type).toBe("coffee_table");
    expect(classifyText("[TEST] Walnut End Table for Sofa")?.type).toBe("side_table");
    expect(classifyText("[TEST] Bedside Table with Drawer")?.type).toBe("nightstand");
    expect(classifyText("[TEST] Curved Back Dining Chair")?.type).toBe("chair");
    expect(classifyText("[TEST] Sofa Bed Convertible")?.type).toBe("sofa_bed");
    expect(classifyText("[TEST] Decorative ceramic vase")).toBeNull();
  });

  it("falls back to the recorded category, and reports neither when nothing names a type", () => {
    expect(classifyProduct({ title: "[TEST] Model X-200 walnut", category: "bed" })).toMatchObject({ type: "bed", from: "category" });
    expect(classifyProduct({ title: "[TEST] Model X-200 walnut", category: null })).toBeNull();
  });

  it("takes the analysed type from the subtype before the broad category", () => {
    expect(referenceType({ category: "table", subtype: "nesting_coffee_table_set", searchQueries: [] })).toMatchObject({ type: "coffee_table", from: "subtype" });
    expect(referenceType({ category: "bed", subtype: "panel_bed", searchQueries: [] })).toMatchObject({ type: "bed" });
    expect(referenceType({ category: "table", subtype: undefined, searchQueries: ["oval coffee table wood", "pebble coffee table"] })).toMatchObject({ type: "coffee_table", from: "queries" });
    expect(referenceType({ category: "Chair", subtype: "Dining Chair", searchQueries: [] })?.type).toBe("chair");
  });

  it("offers the same type or an explicitly related one, never a bed for a coffee table", () => {
    expect(compareTypes("coffee_table", "coffee_table")).toBe("same_type");
    expect(compareTypes("coffee_table", "side_table")).toBe("related_type");
    expect(compareTypes("coffee_table", "bed")).toBe("different_type");
    expect(compareTypes("bed", "coffee_table")).toBe("different_type");
    expect(compareTypes("bed", "nightstand")).toBe("different_type");
    expect(compareTypes("chair", "sofa")).toBe("different_type");
  });

  it("finds shared descriptive words without counting unknown attributes", () => {
    const terms = referenceTerms({
      searchQueries: ["oval wooden nesting coffee table"],
      structure: [{ attribute: "legs", certainty: "observed", value: "Three slim tapered legs" }],
      appearance: [{ attribute: "species", certainty: "unknown", rationale: "walnut cannot be confirmed" }],
      distinctiveFeatures: [],
    });
    expect(terms).toContain("oval");
    expect(terms).not.toContain("walnut");
    expect(matchedTerms("[TEST] Oval Wooden Tea Tables with Tapered Legs", terms)).toEqual(expect.arrayContaining(["oval", "wooden", "tapered", "legs"]));
  });
});
