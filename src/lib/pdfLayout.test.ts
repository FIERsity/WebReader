import { describe, expect, it } from "vitest";
import { buildPdfPageLayout, locatePdfPosition, pdfWindowForPage, scrollTopForPdfLocation } from "./pdfLayout";

describe("continuous PDF layout", () => {
  it("uses each page's real aspect ratio", () => {
    const layout = buildPdfPageLayout([0.5, 2], 600, 20);
    expect(layout.heights).toEqual([1220, 320]);
    expect(layout.offsets).toEqual([0, 1220]);
    expect(layout.totalHeight).toBe(1540);
  });

  it("round-trips page and page-relative offset", () => {
    const layout = buildPdfPageLayout([0.75, 1.4, 0.5], 720);
    const scrollTop = scrollTopForPdfLocation(layout, { page: 2, offset: 0.4 });
    const location = locatePdfPosition(layout, scrollTop + 24);
    expect(location.page).toBe(2);
    expect(location.offset).toBeCloseTo(0.4);
  });

  it("keeps the mounted page window bounded", () => {
    expect(pdfWindowForPage(500, 1000)).toEqual([496, 497, 498, 499, 500, 501, 502, 503, 504]);
    expect(pdfWindowForPage(1, 1000)).toEqual([1, 2, 3, 4, 5]);
  });
});
