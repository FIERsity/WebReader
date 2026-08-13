import { describe, expect, it } from "vitest";
import {
  analyzePdfTextPage, buildPdfPaperDocument, type PdfRawTextItem,
} from "./pdfText";

const PAGE_WIDTH = 600;
const PAGE_HEIGHT = 800;

function item(text: string, left: number, top: number, width: number, fontSize = 11, dir = "ltr"): PdfRawTextItem {
  return {
    str: text,
    dir,
    transform: [fontSize, 0, 0, fontSize, left, PAGE_HEIGHT - top - fontSize],
    width,
    height: fontSize,
    fontName: "Synthetic",
    hasEOL: false,
  };
}

function paragraph(text: string, left: number, top: number, lineWidth = 230): PdfRawTextItem[] {
  const midpoint = Math.ceil(text.length / 2);
  return [
    item(text.slice(0, midpoint), left, top, lineWidth),
    item(text.slice(midpoint), left, top + 15, lineWidth),
  ];
}

describe("PDF paper text analysis", () => {
  it("reconstructs single-column lines and removes soft line hyphenation", () => {
    const page = analyzePdfTextPage({
      page: 1,
      width: PAGE_WIDTH,
      height: PAGE_HEIGHT,
      items: [
        item("A Local-", 70, 90, 54),
        item("first workflow for reproducible", 70, 105, 190),
        item("research translation.", 70, 120, 130),
        ...paragraph("A second paragraph ends independently.", 70, 165, 300),
      ],
    });

    expect(page.quality).toBe("supported");
    expect(page.columnCount).toBe(1);
    expect(page.blocks.map((block) => block.text)).toEqual([
      "A Local-first workflow for reproducible research translation.",
      "A second paragraph ends independently.",
    ]);
  });

  it("removes an ASCII wrap hyphen only when the preceding line is full width", () => {
    const page = analyzePdfTextPage({
      page: 1,
      width: PAGE_WIDTH,
      height: PAGE_HEIGHT,
      items: [
        item("The anthropo-", 70, 90, 190),
        item("genic impact remains measurable.", 70, 105, 185),
        ...paragraph("A second paragraph ends independently.", 70, 165, 300),
      ],
    });
    expect(page.blocks[0]?.text).toContain("anthropogenic impact");
  });

  it("normalizes all-caps letter spacing used by journal labels", () => {
    const page = analyzePdfTextPage({
      page: 1,
      width: PAGE_WIDTH,
      height: PAGE_HEIGHT,
      items: [
        item("R ES E A RC H", 70, 30, 100, 9),
        ...paragraph("This paragraph provides enough body text for analysis.", 70, 100, 300),
      ],
    });
    expect(page.blocks[0]?.text).toBe("RESEARCH");
  });

  it("joins consecutive title lines into one stable display block", () => {
    const page = analyzePdfTextPage({
      page: 1,
      width: PAGE_WIDTH,
      height: PAGE_HEIGHT,
      items: [
        item("Planetary boundaries: Guiding", 70, 50, 360, 22),
        item("human development on a", 70, 78, 330, 22),
        item("changing planet", 70, 106, 240, 22),
        ...paragraph("This paragraph provides enough body text for analysis.", 70, 180, 300),
      ],
    });
    expect(page.blocks[0]).toMatchObject({
      kind: "title",
      text: "Planetary boundaries: Guiding human development on a changing planet",
    });
  });

  it("orders a spanning title before the left and right columns", () => {
    const page = analyzePdfTextPage({
      page: 2,
      width: PAGE_WIDTH,
      height: PAGE_HEIGHT,
      items: [
        item("Planetary boundaries", 90, 40, 420, 22),
        ...paragraph("Left column first paragraph has enough text.", 55, 120),
        ...paragraph("Left column second paragraph has enough text.", 55, 190),
        ...paragraph("Left column third paragraph has enough text.", 55, 260),
        ...paragraph("Right column first paragraph has enough text.", 315, 120),
        ...paragraph("Right column second paragraph has enough text.", 315, 190),
        ...paragraph("Right column third paragraph has enough text.", 315, 260),
      ],
    });

    expect(page.columnCount).toBe(2);
    expect(page.blocks[0]).toMatchObject({ kind: "title", column: "span", text: "Planetary boundaries" });
    expect(page.blocks.slice(1, 4).every((block) => block.column === "left")).toBe(true);
    expect(page.blocks.slice(4).every((block) => block.column === "right")).toBe(true);
  });

  it("rejects pages without enough usable text and vertical-text pages", () => {
    expect(analyzePdfTextPage({
      page: 3,
      width: PAGE_WIDTH,
      height: PAGE_HEIGHT,
      items: [item("12", 290, 760, 12)],
    })).toMatchObject({ quality: "rejected", issues: ["insufficient-text"], blocks: [] });

    const vertical = Array.from({ length: 8 }, (_, index) => item(`vertical text ${index}`, 80 + index * 20, 100, 90, 11, "ttb"));
    expect(analyzePdfTextPage({ page: 4, width: PAGE_WIDTH, height: PAGE_HEIGHT, items: vertical }))
      .toMatchObject({ quality: "rejected", issues: expect.arrayContaining(["vertical-text"]) });
  });

  it("rejects garbled private-use and replacement-character text layers", () => {
    const page = analyzePdfTextPage({
      page: 4,
      width: PAGE_WIDTH,
      height: PAGE_HEIGHT,
      items: [item("\ue001\ue002���\ue003\ue004 hidden text layer with unusable glyphs", 70, 120, 360)],
    });
    expect(page.quality).toBe("rejected");
    expect(page.issues).toContain("invalid-text-layer");
    expect(page.blocks).toEqual([]);
  });

  it("assigns stable IDs for unchanged page geometry and text", () => {
    const input = {
      page: 5,
      width: PAGE_WIDTH,
      height: PAGE_HEIGHT,
      items: paragraph("Stable source blocks keep a repeatable identity.", 70, 120, 300),
    };
    const first = analyzePdfTextPage(input);
    const second = analyzePdfTextPage(input);
    expect(first.blocks[0]?.id).toBe(second.blocks[0]?.id);
  });

  it("keeps IDs stable when an unrelated preceding block is added", () => {
    const source = paragraph("Stable source blocks keep a repeatable identity.", 70, 220, 300);
    const base = analyzePdfTextPage({ page: 6, width: PAGE_WIDTH, height: PAGE_HEIGHT, items: source });
    const shifted = analyzePdfTextPage({
      page: 6,
      width: PAGE_WIDTH,
      height: PAGE_HEIGHT,
      items: [item("Unrelated heading", 70, 80, 240, 18), ...source],
    });
    expect(shifted.blocks.find((block) => block.text === base.blocks[0]?.text)?.id).toBe(base.blocks[0]?.id);
  });

  it("marks over-fragmented pages for review", () => {
    const items = Array.from({ length: 84 }, (_, index) => item(`Fragment ${index} with enough text.`, 60, 20 + index * 8, 240));
    const page = analyzePdfTextPage({ page: 7, width: PAGE_WIDTH, height: PAGE_HEIGHT, items });
    expect(page.quality).toBe("review");
    expect(page.issues).toContain("over-fragmented");
    const document = buildPdfPaperDocument([page]);
    expect(document.translatedBlockCount).toBe(0);
  });

  it("removes recurring marginal headers and merges cross-page soft hyphenation", () => {
    const pages = [1, 2, 3].map((pageNumber) => analyzePdfTextPage({
      page: pageNumber,
      width: PAGE_WIDTH,
      height: PAGE_HEIGHT,
      items: [
        item("SCIENCE RESEARCH ARTICLE", 170, 18, 260, 9),
        ...paragraph(pageNumber === 1 ? "The analysis contin\u00ad" : pageNumber === 2 ? "ues across a physical page boundary." : "A final independent paragraph remains visible.", 70, pageNumber === 1 ? 680 : 65, 360),
      ],
    }));
    const document = buildPdfPaperDocument(pages);

    expect(document.blocks.some((block) => block.text === "SCIENCE RESEARCH ARTICLE")).toBe(false);
    expect(document.blocks.some((block) => block.text.includes("continues across"))).toBe(true);
    expect(document.rejectedPages).toEqual([]);
  });
});
