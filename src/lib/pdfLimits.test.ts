import { describe, expect, it } from "vitest";
import { fitsCanvasLimit, MAX_PDF_CANVAS_PIXELS } from "./pdfLimits";

describe("PDF canvas limits", () => {
  it("includes device pixel scaling in the allocation limit", () => {
    expect(fitsCanvasLimit(2000, 2000, 2)).toBe(true);
    expect(fitsCanvasLimit(2001, 2000, 2)).toBe(false);
    expect(MAX_PDF_CANVAS_PIXELS).toBe(16_000_000);
  });

  it("rejects invalid dimensions", () => {
    expect(fitsCanvasLimit(Number.NaN, 100, 1)).toBe(false);
    expect(fitsCanvasLimit(100, 0, 1)).toBe(false);
  });
});
