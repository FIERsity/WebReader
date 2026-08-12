import { describe, expect, it } from "vitest";
import { DEFAULT_PREFERENCES } from "../types/library";
import { normalizePreferences } from "./preferences";

describe("reader preference migration", () => {
  it("returns current defaults for missing data", () => {
    expect(normalizePreferences(undefined)).toEqual(DEFAULT_PREFERENCES);
  });

  it("migrates legacy scale and preserves supported values", () => {
    expect(normalizePreferences({ theme: "night", fontScale: 1.24, lineHeight: 1.8 })).toEqual({
      ...DEFAULT_PREFERENCES,
      theme: "night",
      fontSizePercent: 120,
      lineHeight: 1.9,
    });
  });

  it("bounds numbers and rejects unknown enum values", () => {
    expect(normalizePreferences({
      theme: "sepia",
      fontSizePercent: 900,
      fontFamily: "remote-font",
      lineHeight: Number.NaN,
      paragraphIndent: 5,
      contentWidth: "huge",
    })).toEqual({
      ...DEFAULT_PREFERENCES,
      fontSizePercent: 200,
    });
  });
});
