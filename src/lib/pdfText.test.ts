import { describe, expect, it } from "vitest";
import {
  analyzePdfTextPage, buildPdfPaperDocument, MAX_PDF_BLOCK_CHARACTERS, type PdfRawTextItem,
} from "./pdfText";

const PAGE_WIDTH = 600;
const PAGE_HEIGHT = 800;

function item(text: string, left: number, top: number, width: number, fontSize = 11, dir = "ltr", hasEOL = true): PdfRawTextItem {
  return {
    str: text,
    dir,
    transform: [fontSize, 0, 0, fontSize, left, PAGE_HEIGHT - top - fontSize],
    width,
    height: fontSize,
    fontName: "Synthetic",
    hasEOL,
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

  it("attaches small author superscripts instead of emitting standalone blocks", () => {
    const page = analyzePdfTextPage({
      page: 1,
      width: PAGE_WIDTH,
      height: PAGE_HEIGHT,
      items: [
        item("Research title with enough descriptive text", 70, 70, 360, 20),
        item("Author One,", 70, 120, 100, 13),
        item("1,2*", 170, 108, 20, 6),
        item("Author Two", 195, 120, 90, 13),
        item("This paragraph provides enough body text for reliable analysis.", 70, 180, 420),
      ],
    });

    expect(page.blocks.some((block) => block.text === "1,2*")).toBe(false);
    expect(page.blocks.some((block) => block.text.includes("Author One,1,2*"))).toBe(true);
  });

  it("keeps adjacent journal columns as separate physical lines", () => {
    const page = analyzePdfTextPage({
      page: 2,
      width: PAGE_WIDTH,
      height: PAGE_HEIGHT,
      items: [
        item("Left column first line with enough text", 55, 120, 235),
        item("Right column first line with enough text", 310, 120, 235),
        item("Left column second line with enough text", 55, 155, 235),
        item("Right column second line with enough text", 310, 155, 235),
        item("Left column third line with enough text", 55, 190, 235),
        item("Right column third line with enough text", 310, 190, 235),
        item("Left column fourth line with enough text", 55, 225, 235),
        item("Right column fourth line with enough text", 310, 225, 235),
        item("Left column fifth line with enough text", 55, 260, 235),
        item("Right column fifth line with enough text", 310, 260, 235),
      ],
    });

    expect(page.columnCount).toBe(2);
    expect(page.blocks.map((block) => block.text)).toEqual([
      "Left column first line with enough text",
      "Left column second line with enough text",
      "Left column third line with enough text",
      "Left column fourth line with enough text",
      "Left column fifth line with enough text",
      "Right column first line with enough text",
      "Right column second line with enough text",
      "Right column third line with enough text",
      "Right column fourth line with enough text",
      "Right column fifth line with enough text",
    ]);
  });

  it("merges an explicit wrap hyphen across column flow", () => {
    const page = analyzePdfTextPage({
      page: 2,
      width: PAGE_WIDTH,
      height: PAGE_HEIGHT,
      items: [
        item("Left column body establishes a stable journal layout.", 55, 120, 230),
        item("Right column supporting line establishes the same gutter.", 315, 120, 230),
        item("Left column second paragraph remains visible here.", 55, 180, 230),
        item("Right column second paragraph remains visible here.", 315, 180, 230),
        item("Left column third paragraph remains visible here.", 55, 240, 230),
        item("Right column third paragraph remains visible here.", 315, 240, 230),
        item("Left column fourth paragraph remains visible here.", 55, 300, 230),
        item("Right column fourth paragraph remains visible here.", 315, 300, 230),
        item("Left column fifth paragraph remains visible here.", 55, 360, 230),
        item("Right column fifth paragraph remains visible here.", 315, 360, 230),
        item("Left column sixth paragraph remains visible here.", 55, 420, 230),
        item("Right column sixth paragraph remains visible here.", 315, 420, 230),
        item("The method continues with an ap-", 55, 480, 230),
        item("Right column footer line keeps the gutter measurable.", 315, 480, 230),
        item("proach that begins at the top of the right column and remains long enough for analysis.", 315, 90, 230),
      ],
    });
    const document = buildPdfPaperDocument([page]);

    expect(document.blocks.some((block) => block.text.includes("an approach that begins"))).toBe(true);
  });

  it("does not mistake repeated single-column indentation for a second column", () => {
    const page = analyzePdfTextPage({
      page: 2,
      width: PAGE_WIDTH,
      height: PAGE_HEIGHT,
      items: [
        item("A single-column introduction remains the only reading flow.", 70, 100, 420),
        item("Indented list item one remains inside that same reading flow.", 250, 180, 220),
        item("Indented list item two remains inside that same reading flow.", 250, 240, 220),
        item("Indented list item three remains inside that same reading flow.", 250, 300, 220),
        item("Indented list item four remains inside that same reading flow.", 250, 330, 220),
        item("Indented list item five remains inside that same reading flow.", 250, 360, 220),
        item("Indented list item six remains inside that same reading flow.", 250, 390, 220),
        item("A concluding paragraph returns to the ordinary left margin.", 70, 450, 420),
      ],
    });

    expect(page.columnCount).toBe(1);
    expect(page.blocks.every((block) => block.column === "span")).toBe(true);
  });

  it("uses a spanning heading to separate local two-column regions", () => {
    const page = analyzePdfTextPage({
      page: 2,
      width: PAGE_WIDTH,
      height: PAGE_HEIGHT,
      items: [
        ...Array.from({ length: 5 }, (_, index) => item(`Left upper line ${index} with enough text`, 55, 120 + index * 18, 230)),
        ...Array.from({ length: 5 }, (_, index) => item(`Right upper line ${index} with enough text`, 315, 120 + index * 18, 230)),
        item("Spanning section heading", 55, 250, 490, 17),
        ...Array.from({ length: 5 }, (_, index) => item(`Left lower line ${index} with enough text`, 55, 300 + index * 18, 230)),
        ...Array.from({ length: 5 }, (_, index) => item(`Right lower line ${index} with enough text`, 315, 300 + index * 18, 230)),
      ],
    });
    const texts = page.blocks.map((block) => block.text);
    const heading = texts.findIndex((text) => text.includes("Spanning section heading"));

    expect(heading).toBeGreaterThan(0);
    expect(texts.slice(0, heading).some((text) => text.includes("Right upper"))).toBe(true);
    expect(texts.slice(heading + 1).some((text) => text.includes("Left lower"))).toBe(true);
    expect(texts.findIndex((text) => text.includes("Right lower"))).toBeGreaterThan(texts.findIndex((text) => text.includes("Left lower")));
  });

  it("does not mistake repeated inline text splits for a second column", () => {
    const items = Array.from({ length: 14 }, (_, index) => [
      item(`Single-column prefix ${index} with`, 70, 80 + index * 22, 340, 11, "ltr", false),
      item(`continued inline text ${index}.`, 420, 80 + index * 22, 120, 11, "ltr", true),
    ]).flat();
    const page = analyzePdfTextPage({ page: 2, width: PAGE_WIDTH, height: PAGE_HEIGHT, items });

    expect(page.columnCount).toBe(1);
    expect(page.blocks.map((block) => block.text).join(" ")).toContain("Single-column prefix 0 with continued inline text 0.");
  });

  it("uses a same-size semantic heading to separate local columns without dropping overlap", () => {
    const upper = Array.from({ length: 5 }, (_, index) => [
      item(`Left upper ${index} with enough text`, 55, 100 + index * 18, 230),
      item(`Right upper ${index} with enough text`, 315, 100 + index * 18, 230),
    ]).flat();
    const lower = Array.from({ length: 5 }, (_, index) => [
      item(`Left lower ${index} with enough text`, 55, 260 + index * 18, 230),
      item(`Right lower ${index} with enough text`, 315, 260 + index * 18, 230),
    ]).flat();
    const overlap = item("Right overlap must remain", 315, 218, 190);
    overlap.sourceIndex = 777;
    const page = analyzePdfTextPage({
      page: 2,
      width: PAGE_WIDTH,
      height: PAGE_HEIGHT,
      items: [...upper, item("Introduction", 55, 220, 490), overlap, ...lower],
    });
    const texts = page.blocks.map((block) => block.text);
    const heading = texts.findIndex((text) => text === "Introduction");

    expect(heading).toBeGreaterThan(0);
    expect(texts.slice(0, heading).some((text) => text.includes("Right upper"))).toBe(true);
    expect(page.blocks.some((block) => block.sourceItems.some((source) => source.index === 777))).toBe(true);
  });

  it("uses a same-size Chinese semantic heading to separate local columns", () => {
    const items = [
      ...Array.from({ length: 5 }, (_, index) => [
        item(`左栏上部内容第${index}行`, 55, 100 + index * 18, 230),
        item(`右栏上部内容第${index}行`, 315, 100 + index * 18, 230),
      ]).flat(),
      item("二 研究方法", 55, 220, 490),
      ...Array.from({ length: 5 }, (_, index) => [
        item(`左栏下部内容第${index}行`, 55, 260 + index * 18, 230),
        item(`右栏下部内容第${index}行`, 315, 260 + index * 18, 230),
      ]).flat(),
    ];
    const page = analyzePdfTextPage({ page: 2, width: PAGE_WIDTH, height: PAGE_HEIGHT, items });
    const texts = page.blocks.map((block) => block.text);
    const heading = texts.findIndex((text) => text === "二 研究方法");

    expect(heading).toBeGreaterThan(0);
    expect(page.blocks.find((block) => block.text === "二 研究方法")?.kind).toBe("heading");
    expect(texts.slice(0, heading).some((text) => text.includes("右栏上部"))).toBe(true);
    expect(texts.findIndex((text) => text.includes("右栏下部"))).toBeGreaterThan(texts.findIndex((text) => text.includes("左栏下部")));
  });

  it("uses same-size Bibliography as a spanning reference boundary", () => {
    const items = [
      ...Array.from({ length: 5 }, (_, index) => [
        item(`Left body ${index} with enough text`, 55, 100 + index * 18, 230),
        item(`Right body ${index} with enough text`, 315, 100 + index * 18, 230),
      ]).flat(),
      item("Bibliography", 55, 220, 490),
      item("1. First reference entry with enough identifying text.", 55, 260, 230),
      item("2. Second reference entry with enough identifying text.", 315, 260, 230),
    ];
    const page = analyzePdfTextPage({ page: 2, width: PAGE_WIDTH, height: PAGE_HEIGHT, items });
    const heading = page.blocks.find((block) => block.text === "Bibliography");

    expect(heading).toMatchObject({ kind: "heading", column: "span" });
    expect(page.blocks.filter((block) => /^\d+[.] /u.test(block.text)).every((block) => block.kind === "reference")).toBe(true);
  });

  it("starts reference mode after a numbered Chinese heading", () => {
    const page = analyzePdfTextPage({
      page: 2,
      width: PAGE_WIDTH,
      height: PAGE_HEIGHT,
      items: [
        item("二 参考文献", 70, 100, 420),
        item("1. 第一条参考文献包含足够的文本。", 70, 140, 420),
        item("2. 第二条参考文献也包含足够的文本。", 70, 180, 420),
      ],
    });

    expect(page.blocks[0]?.kind).toBe("heading");
    expect(page.blocks.slice(1).every((block) => block.kind === "reference")).toBe(true);
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

  it("keeps over-fragmented pages as conservative small blocks", () => {
    const items = Array.from({ length: 84 }, (_, index) => item(`Fragment ${index} with enough text.`, 60, 20 + index * 8, 240));
    const page = analyzePdfTextPage({ page: 7, width: PAGE_WIDTH, height: PAGE_HEIGHT, items });
    expect(page.quality).toBe("review");
    expect(page.issues).toContain("over-fragmented");
    expect(buildPdfPaperDocument([page]).blocks).toHaveLength(page.blocks.length);
  });

  it("marks bibliography entries as references", () => {
    const page = analyzePdfTextPage({
      page: 8,
      width: PAGE_WIDTH,
      height: PAGE_HEIGHT,
      items: [
        item("References", 70, 80, 180, 18),
        ...paragraph("1. Author A. A reproducible study. Journal 12, 34-40 (2024).", 70, 125, 420),
        ...paragraph("2. Author B. Another paper. https://doi.org/10.1000/example", 70, 180, 420),
      ],
    });
    expect(page.blocks.slice(1).every((block) => block.kind === "reference")).toBe(true);
  });

  it("splits anomalously long paragraphs at line boundaries before batching", () => {
    const lines = Array.from({ length: 80 }, (_, index) => item(`Line ${index} ${"word ".repeat(20)}`, 70, 40 + index * 8, 420));
    const page = analyzePdfTextPage({ page: 9, width: PAGE_WIDTH, height: 1_200, items: lines });
    expect(page.blocks.length).toBeGreaterThan(1);
    expect(page.blocks.every((block) => block.text.length <= MAX_PDF_BLOCK_CHARACTERS + 200)).toBe(true);
  });

  it("keeps an explicit column-merge ID stable when unrelated items precede it", () => {
    const source = [
      ...Array.from({ length: 8 }, (_, index) => [
        item(`Left line ${index} keeps the gutter stable.`, 55, 120 + index * 50, 230),
        item(`Right line ${index} keeps the gutter stable.`, 315, 120 + index * 50, 230),
      ]).flat(),
      item("A continuation ends with inter-", 55, 500, 230),
      item("national evidence at the right-column start.", 315, 90, 230),
    ];
    const first = buildPdfPaperDocument([analyzePdfTextPage({ page: 2, width: PAGE_WIDTH, height: PAGE_HEIGHT, items: source })]);
    const shifted = buildPdfPaperDocument([analyzePdfTextPage({
      page: 2,
      width: PAGE_WIDTH,
      height: PAGE_HEIGHT,
      items: [item("Unrelated marginal label", 70, 30, 150), ...source],
    })]);
    const firstMerged = first.blocks.find((block) => block.text.includes("international evidence"));
    const shiftedMerged = shifted.blocks.find((block) => block.text.includes("international evidence"));

    expect(firstMerged?.id).toBeDefined();
    expect(shiftedMerged?.id).toBe(firstMerged?.id);
  });

  it("keeps cross-page source blocks separate for page-by-page proofing", () => {
    const pages = [1, 2].map((pageNumber) => analyzePdfTextPage({
      page: pageNumber,
      width: PAGE_WIDTH,
      height: PAGE_HEIGHT,
      items: paragraph(pageNumber === 1
        ? "This sufficiently long reconstruction paragraph continues across the page bound\u00ad"
        : "ary and remains traceable to both original page regions after deterministic reflow.", 70, pageNumber === 1 ? 680 : 65, 360),
    }));
    const document = buildPdfPaperDocument(pages);

    expect(document.blocks.filter((block) => block.fragments[0]?.page === 1)).toHaveLength(1);
    expect(document.blocks.filter((block) => block.fragments[0]?.page === 2)).toHaveLength(1);
    expect(document.blocks.every((block) => new Set(block.fragments.map((fragment) => fragment.page)).size === 1)).toBe(true);
  });

  it("removes recurring marginal headers while preserving cross-page proof blocks", () => {
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
    expect(document.blocks.some((block) => block.text.endsWith("contin\u00ad"))).toBe(true);
    expect(document.blocks.some((block) => block.text.startsWith("ues across"))).toBe(true);
    expect(document.rejectedPages).toEqual([]);
  });
});
