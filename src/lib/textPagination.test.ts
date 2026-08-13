import { describe, expect, it } from "vitest";
import {
  calculateTextPageLayout,
  findSourceRangeIndex,
  pageCountForExtent,
  pageIndexAtPosition,
  sourceOffsetForRange,
} from "./textPagination";

const ranges = [
  { start: 0, end: 10 },
  { start: 14, end: 24 },
  { start: 30, end: 40 },
];

describe("text pagination", () => {
  it("uses one centered content column per viewport", () => {
    expect(calculateTextPageLayout(1200, 800, 720)).toEqual({
      viewportWidth: 1200,
      contentWidth: 720,
      contentHeight: 648,
      sideInset: 240,
      topInset: 52,
      bottomInset: 100,
    });
  });

  it("keeps compact layouts inside the viewport", () => {
    expect(calculateTextPageLayout(338, 622, 880)).toEqual({
      viewportWidth: 338,
      contentWidth: 242,
      contentHeight: 498,
      sideInset: 48,
      topInset: 34,
      bottomInset: 90,
    });
  });

  it("rounds partial horizontal extents up to a complete page", () => {
    expect(pageCountForExtent(3600, 1200)).toBe(3);
    expect(pageCountForExtent(3601, 1200)).toBe(4);
    expect(pageIndexAtPosition(0, 1200, 3)).toBe(0);
    expect(pageIndexAtPosition(1199, 1200, 3)).toBe(1);
    expect(pageIndexAtPosition(9999, 1200, 3)).toBe(2);
  });

  it("finds source blocks without scanning from the beginning", () => {
    expect(findSourceRangeIndex(ranges, 0)).toBe(0);
    expect(findSourceRangeIndex(ranges, 18)).toBe(1);
    expect(findSourceRangeIndex(ranges, 100)).toBe(2);
  });

  it("normalizes offsets that fall between text blocks", () => {
    expect(sourceOffsetForRange(ranges, 8)).toEqual({ index: 0, offset: 8 });
    expect(sourceOffsetForRange(ranges, 12)).toEqual({ index: 1, offset: 14 });
    expect(sourceOffsetForRange(ranges, 100)).toEqual({ index: 2, offset: 40 });
  });
});
