import { describe, expect, it } from "vitest";
import { searchPdfTextItems, type PdfSearchTextItem } from "./pdfSearch";

const item = (text: string, sourceIndex: number): PdfSearchTextItem => ({
  text,
  sourceIndex,
  fragment: { page: 2, left: sourceIndex / 10, top: 0.1, width: 0.1, height: 0.03 },
});

describe("PDF search text mapping", () => {
  it("finds phrases split across PDF text items and maps every source fragment", () => {
    const outcome = searchPdfTextItems([item("Web", 1), item("Reader", 2), item("local", 3)], "web reader", {
      page: 2,
      label: "Page 2",
      maxResults: 10,
    });
    expect(outcome.results).toHaveLength(1);
    expect(outcome.results[0]).toMatchObject({ target: "2:0", label: "Page 2", excerpt: { match: "Web Reader" } });
    expect(outcome.results[0]?.fragments).toHaveLength(2);
  });

  it("joins adjacent CJK items without inserting spaces", () => {
    const outcome = searchPdfTextItems([item("本地", 1), item("阅读器", 2)], "本地阅读器", {
      page: 2,
      label: "第 2 页",
      maxResults: 10,
    });
    expect(outcome.results[0]?.excerpt.match).toBe("本地阅读器");
  });
});
