import { describe, expect, it } from "vitest";
import { parsePdfLocation, serializePdfLocation } from "./pdfLocation";

describe("PDF continuous locator", () => {
  it("keeps legacy page-only locators readable", () => {
    expect(parsePdfLocation("17")).toEqual({ page: 17, offset: 0 });
  });

  it("round-trips page and within-page progress", () => {
    expect(parsePdfLocation(serializePdfLocation(9, 0.375))).toEqual({ page: 9, offset: 0.375 });
  });

  it("clamps malformed values to safe defaults", () => {
    expect(parsePdfLocation("bad:4")).toEqual({ page: 1, offset: 1 });
    expect(serializePdfLocation(0, -1)).toBe("1");
  });
});
